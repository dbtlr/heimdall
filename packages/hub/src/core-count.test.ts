import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub } from './testing/hub.ts';
import { startTestServer } from './testing/postgres.ts';

beforeAll(startTestServer, 60_000);

test('an out-of-range count leaves the Report stored and the known count unchanged', async () => {
  await using h = await startHub();
  const initial = report('server-1', [NOW]);
  initial.samples[0]!.cpu.cores = 8;
  expect((await push(h.hub, initial, { token: 'server-token' })).status).toBe(200);
  const body = report('server-1', [NOW + 15_000]);
  body.samples[0]!.cpu = { busyPercent: 37, cores: 2 ** 31 };
  const response = await push(h.hub, body, { token: 'server-token' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ skipped: 0, stored: 1 });
  const [system]: { cpu_cores: number }[] = await h.db
    .sql`SELECT cpu_cores FROM systems WHERE name = 'server-1'`;
  expect(system?.cpu_cores).toBe(8);
  const [vitals]: { cpu_busy_percent: number; load_1: number; memory_used_bytes: number }[] =
    await h.db.sql`
    SELECT cpu_busy_percent, load_1, memory_used_bytes::float8 AS memory_used_bytes FROM vitals_samples
    WHERE system = 'server-1' AND t = ${new Date(NOW + 15_000)}
  `;
  expect(vitals).toEqual({
    cpu_busy_percent: 37,
    load_1: body.samples[0]!.load[0],
    memory_used_bytes: body.samples[0]!.memory.usedBytes,
  });
});

test('only a strictly newer sample can replace the core count', async () => {
  await using h = await startHub();
  for (const [offset, cores, expected] of [
    [200, 8, 8],
    [100, 4, 8],
    [200, 2, 8],
    [300, 16, 16],
    [400, undefined, 16],
    [350, 32, 32],
  ] satisfies [number, number | undefined, number][]) {
    const body = report('server-1', [NOW + (offset - 400) * 1000]);
    body.samples = body.samples.map((sample) => ({ ...sample, cpu: { ...sample.cpu, cores } }));
    // oxlint-disable-next-line no-await-in-loop -- Arrival order is the behavior under test.
    expect((await push(h.hub, body, { token: 'server-token' })).status).toBe(200);
    // oxlint-disable-next-line no-await-in-loop -- Check the state after each Report commits.
    const [row]: { cpu_cores: number }[] = await h.db
      .sql`SELECT cpu_cores FROM systems WHERE name = 'server-1'`;
    expect(row?.cpu_cores).toBe(expected);
  }
});

test('uses only the newest sample in a Report for the core count', async () => {
  await using h = await startHub();
  const first = report('server-1', [NOW, NOW + 15_000]);
  first.samples = first.samples.map((sample, i) => ({
    ...sample,
    cpu: { ...sample.cpu, cores: i === 0 ? 2 : 8 },
  }));
  expect((await push(h.hub, first, { token: 'server-token' })).status).toBe(200);
  const newer = report('server-1', [NOW + 30_000, NOW + 45_000]);
  newer.samples = newer.samples.map((sample, i) => ({
    ...sample,
    cpu: { ...sample.cpu, cores: i === 0 ? 16 : undefined },
  }));
  expect((await push(h.hub, newer, { token: 'server-token' })).status).toBe(200);
  const [row]: { cpu_cores: number; cpu_cores_at: Date }[] = await h.db.sql`
    SELECT cpu_cores, cpu_cores_at FROM systems WHERE name = 'server-1'
  `;
  expect(row).toEqual({ cpu_cores: 8, cpu_cores_at: new Date(NOW + 15_000) });
});

const withCores = (times: number[], cores: number | undefined) => {
  const body = report('server-1', times);
  body.samples = body.samples.map((sample) => ({ ...sample, cpu: { ...sample.cpu, cores } }));
  return body;
};

const storedCores = async (h: Awaited<ReturnType<typeof startHub>>) => {
  const [row]: { cpu_cores: number | null; cpu_cores_at: Date | null }[] = await h.db.sql`
    SELECT cpu_cores, cpu_cores_at FROM systems WHERE name = 'server-1'
  `;
  return row;
};

test('a System that exists without a count takes the first count it hears', async () => {
  await using h = await startHub();
  expect((await push(h.hub, withCores([NOW], undefined), { token: 'server-token' })).status).toBe(
    200,
  );
  expect(await storedCores(h)).toEqual({ cpu_cores: null, cpu_cores_at: null });
  expect((await push(h.hub, withCores([NOW - 60_000], 4), { token: 'server-token' })).status).toBe(
    200,
  );
  expect(await storedCores(h)).toEqual({ cpu_cores: 4, cpu_cores_at: new Date(NOW - 60_000) });
});

test('a sample far ahead of the Hub does not set the core count', async () => {
  await using h = await startHub();
  const future = NOW + 365 * 24 * 60 * 60 * 1000;
  expect((await push(h.hub, withCores([future], 8), { token: 'server-token' })).status).toBe(200);
  expect(await storedCores(h)).toEqual({ cpu_cores: null, cpu_cores_at: null });
  expect((await push(h.hub, withCores([NOW], 4), { token: 'server-token' })).status).toBe(200);
  expect(await storedCores(h)).toEqual({ cpu_cores: 4, cpu_cores_at: new Date(NOW) });
});

test('a current count replaces a stored count dated ahead of the Hub', async () => {
  await using h = await startHub();
  const future = NOW + 365 * 24 * 60 * 60 * 1000;
  await h.db.sql`
    INSERT INTO systems (name, last_seen_at, cpu_cores, cpu_cores_at)
    VALUES ('server-1', ${new Date(NOW)}, 8, ${new Date(future)})
  `;
  expect((await push(h.hub, withCores([NOW], 4), { token: 'server-token' })).status).toBe(200);
  expect(await storedCores(h)).toEqual({ cpu_cores: 4, cpu_cores_at: new Date(NOW) });
});
