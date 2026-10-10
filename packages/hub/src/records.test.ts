import { describe, expect, test } from 'bun:test';

import { RecordsReadSchema } from '@heimdall/schema';
import type { JobRecord, MirroredRecord, ServiceRecord } from '@heimdall/schema';

import { MAX_REPORT_BYTES } from './hub.ts';
import { migrate, MIGRATIONS } from './migrations.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

const WEBAPP: ServiceRecord = { name: 'webapp', supervisor: 'systemd', unit: 'webapp.service' };
const DB: ServiceRecord = { name: 'db', supervisor: 'none' };
const BACKUP: JobRecord = {
  label: 'com.example.backup',
  name: 'backup',
  schedule: [{ hour: 3, minute: 30 }],
  scheduler: 'launchd',
};

const service = (record: ServiceRecord): MirroredRecord => ({
  kind: 'service',
  name: record.name,
  record,
});

// A record set as a Collector sends it.
const set = (records: object[], unreadable: { kind: string; name: string }[] = []) => ({
  records,
  unreadable,
});

// Sends `laptop-1`'s Report at `sentAt` (epoch milliseconds), with `records`
// unless it is undefined. Each Report carries a sample no earlier one has.
let sampleTime = NOW;
const send = async (
  h: Hub,
  {
    records,
    sentAt = NOW,
    system = 'laptop-1',
  }: { records?: unknown; sentAt?: number; system?: string },
) => {
  sampleTime += 15_000;
  const token = system === 'laptop-1' ? 'laptop-token' : 'server-token';
  const response = await push(
    h.hub,
    { ...report(system, [sampleTime]), sentAt, ...(records === undefined ? {} : { records }) },
    { token },
  );
  expect(response.status).toBe(200);
};

// `GET /api/v1/records`, checked against the published schema.
const read = async (h: Hub) => {
  const response = await h.hub.fetch(new Request('http://hub.test/api/v1/records'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  return RecordsReadSchema.parse(await response.json()).systems;
};

const entryOf = async (h: Hub, system = 'laptop-1') =>
  (await read(h)).find((entry) => entry.system === system);

describe('the records a Report carries', () => {
  test('are read back with the time they were sent and received', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2500;

    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toEqual({
      receivedAt: new Date(NOW + 2500).toISOString(),
      records: [service(WEBAPP)],
      sentAt: new Date(NOW + 1000).toISOString(),
      system: 'laptop-1',
      unreadable: [],
    });
  });

  test('replace the earlier set, so a forgotten record is gone', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP), service(DB)]) });

    await send(h, { records: set([service(DB)]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toMatchObject({ records: [service(DB)] });
  });

  test('come back sorted by kind, then name', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([service(WEBAPP), { kind: 'job', name: 'backup', record: BACKUP }, service(DB)]),
    });

    const entry = await entryOf(h);
    expect(entry && 'records' in entry && entry.records?.map((r) => `${r.kind}/${r.name}`)).toEqual(
      ['job/backup', 'service/db', 'service/webapp'],
    );
  });

  test('may be empty, which reads as a System that holds none', async () => {
    await using h = await startHub();

    await send(h, { records: set([]) });

    expect(await entryOf(h)).toMatchObject({ records: [], unreadable: [] });
  });

  test('are left as they were by a Report without a set', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    await send(h, { sentAt: NOW + 60_000 });

    expect(await entryOf(h)).toMatchObject({
      records: [service(WEBAPP)],
      sentAt: new Date(NOW).toISOString(),
    });
  });

  test('are ignored when the Hub holds a set sent later', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    await send(h, { records: set([service(DB)]), sentAt: NOW });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });
  });

  test('replace a set sent at the same moment', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    await send(h, { records: set([service(DB)]) });

    expect(await entryOf(h)).toMatchObject({ records: [service(DB)] });
  });

  test('keep each System to its own set', async () => {
    await using h = await startHub();

    await send(h, { records: set([service(WEBAPP)]) });
    await send(h, { records: set([service(DB)]), system: 'server-1' });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });
    expect(await entryOf(h, 'server-1')).toMatchObject({ records: [service(DB)] });
  });

  test('lose a field the Hub does not know', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([{ ...service(WEBAPP), record: { ...WEBAPP, newerField: 'x' } }]),
    });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)], unreadable: [] });
  });

  test('count a record of a kind the Hub does not know as unreadable', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([service(WEBAPP), { kind: 'secret', name: 'vault', record: { name: 'vault' } }]),
    });

    expect(await entryOf(h)).toMatchObject({
      records: [service(WEBAPP)],
      unreadable: [{ kind: 'secret', name: 'vault' }],
    });
  });

  test('list the records the Collector could not read itself', async () => {
    await using h = await startHub();

    await send(h, { records: set([service(WEBAPP)], [{ kind: 'job', name: 'backup' }]) });

    expect(await entryOf(h)).toMatchObject({ unreadable: [{ kind: 'job', name: 'backup' }] });
  });

  test('keep the kind of an unreadable record as text PostgreSQL can store', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([{ kind: 'se\0cret', name: 'vault', record: { name: 'vault' } }]),
    });

    expect(await entryOf(h)).toMatchObject({
      records: [],
      unreadable: [{ kind: 'se\uFFFDcret', name: 'vault' }],
    });
  });
});

describe('a set over budget', () => {
  test('reads as unavailable and drops the earlier records', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    await send(h, { records: { overBudget: { bytes: 9_000_000 } }, sentAt: NOW + 1000 });

    expect(await entryOf(h)).toEqual({
      overBudget: { bytes: 9_000_000 },
      receivedAt: new Date(NOW).toISOString(),
      sentAt: new Date(NOW + 1000).toISOString(),
      system: 'laptop-1',
    });
  });

  test('gives way to the next set that fits', async () => {
    await using h = await startHub();
    await send(h, { records: { overBudget: { bytes: 9_000_000 } } });

    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });
  });

  test('does not replace a set sent later', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    await send(h, { records: { overBudget: { bytes: 9_000_000 } }, sentAt: NOW });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });
  });
});

describe('reading the records', () => {
  test('answers null for a System no Report has carried a set for', async () => {
    await using h = await startHub();
    await send(h, {});

    expect(await read(h)).toEqual([{ records: null, system: 'laptop-1' }]);
  });

  test('lists Systems by name, as the dashboard does', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });
    await send(h, { system: 'server-1' });

    expect((await read(h)).map((entry) => entry.system)).toEqual(['laptop-1', 'server-1']);
  });

  test('answers an empty list when no System has reported', async () => {
    await using h = await startHub();

    expect(await read(h)).toEqual([]);
  });

  test('is open without a token, and answers no other method', async () => {
    await using h = await startHub();

    const post = await h.hub.fetch(
      new Request('http://hub.test/api/v1/records', { body: '{}', method: 'POST' }),
    );

    expect(post.status).toBe(404);
  });

  test('answers 503 when the database cannot answer', async () => {
    const h = await startHub();
    await h.db.sql.close();

    const response = await h.hub.fetch(new Request('http://hub.test/api/v1/records'));

    expect(response.status).toBe(503);
    expect(h.errors).toHaveLength(1);
    await h.db[Symbol.asyncDispose]().catch(() => undefined);
  });
});

test('a Report just over the old 4 MiB cap is accepted', async () => {
  await using h = await startHub();
  const filler = 'x'.repeat(256);
  const records = set(
    Array.from({ length: 12_000 }, (_, i) =>
      service({ ...WEBAPP, name: `svc-${String(i)}`, unit: `${filler}${String(i)}` }),
    ),
  );
  const body = JSON.stringify({ ...report('laptop-1', [NOW]), records });
  expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
  expect(body.length).toBeLessThan(MAX_REPORT_BYTES);

  const response = await push(h.hub, body, { token: 'laptop-token' });

  expect(response.status).toBe(200);
});

test('migration 7 applies on top of version 6 and keeps what was there', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 6),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;

  expect(await migrate(db.sql)).toEqual([7]);

  const rows = await db.sql`SELECT name FROM systems`;
  expect(rows).toHaveLength(1);
});
