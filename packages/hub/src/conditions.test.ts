import { expect, test } from 'bun:test';

import { listSystems, NOW, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

// A Report the schema rejects: it carries no samples.
const invalid = (system: string) => ({ ...report(system, [NOW]), samples: [] });

// What the Hub derived about one System.
const derived = async (h: Hub, system: string) =>
  (await listSystems(h.db.sql)).find((s) => s.name === system);

// The kind and time of each line of a System's Timeline, newest first.
const lines = async (h: Hub, system: string) =>
  ((await derived(h, system))?.timeline ?? []).map(({ at, kind }) => ({ at, kind }));

test('an invalid Report still counts as seeing its System', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  h.clock.now = NOW + 60 * 60_000;

  const response = await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });

  expect(response.status).toBe(422);
  expect((await derived(h, 'laptop-1'))?.lastSeenAt).toBe(NOW + 60 * 60_000);
});

test("a Report naming another System counts as seeing the token's System, not the named one", async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('server-1', [NOW]), { token: 'laptop-token' });

  expect(response.status).toBe(403);
  expect((await listSystems(h.db.sql)).map((s) => s.name)).toEqual(['laptop-1']);
});

test('requests without a known token see no System', async () => {
  await using h = await startHub();

  await push(h.hub, report('laptop-1', [NOW]));
  await push(h.hub, report('laptop-1', [NOW]), { token: 'guess' });

  expect(await listSystems(h.db.sql)).toEqual([]);
});

test('a System heard only through rejections is seen, with its Condition and no Vitals', async () => {
  await using h = await startHub();

  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });

  const laptop = await derived(h, 'laptop-1');
  expect(laptop?.lastSeenAt).toBe(NOW);
  expect(laptop?.conditions.map((c) => c.kind)).toEqual(['reports_rejected']);
  const [{ n }] = await h.db.sql`SELECT count(*)::int AS n FROM vitals_samples`;
  expect(n).toBe(0);
});

test('identical repeated rejections refresh their evidence time without adding history', async () => {
  await using h = await startHub();
  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });
  h.clock.now = NOW + 60_000;

  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });

  const conditions: { latest_at: Date }[] = await h.db.sql`SELECT latest_at FROM conditions`;
  const transitions: { n: number }[] = await h.db
    .sql`SELECT count(*)::int AS n FROM condition_transitions`;
  expect(conditions).toEqual([{ latest_at: new Date(NOW + 60_000) }]);
  expect(transitions).toEqual([{ n: 1 }]);
});

test('a stored Report clears the Condition, and the Timeline holds when it was raised and cleared', async () => {
  await using h = await startHub();
  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });
  h.clock.now = NOW + 5 * 60_000;

  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

  expect((await derived(h, 'laptop-1'))?.conditions).toEqual([]);
  expect(await lines(h, 'laptop-1')).toEqual([
    { at: NOW + 5 * 60_000, kind: 'cleared' },
    { at: NOW, kind: 'raised' },
  ]);
});

test('a rejection after recovery raises the Condition again', async () => {
  await using h = await startHub();
  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });

  expect((await derived(h, 'laptop-1'))?.conditions).toHaveLength(1);
  expect((await lines(h, 'laptop-1')).map((l) => l.kind)).toEqual(['raised', 'cleared', 'raised']);
});

test("one System's Reports neither clear nor show another System's Conditions", async () => {
  await using h = await startHub();
  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });

  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });

  expect((await derived(h, 'laptop-1'))?.conditions).toHaveLength(1);
  expect(await derived(h, 'server-1')).toMatchObject({ conditions: [], timeline: [] });
});

test('a rejection the Hub clock places earlier does not move last seen back', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  h.clock.now = NOW - 60 * 60_000;

  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });

  expect((await derived(h, 'laptop-1'))?.lastSeenAt).toBe(NOW);
});

test('a Condition is never cleared before it was raised, even when the Hub clock steps back', async () => {
  await using h = await startHub();
  h.clock.now = NOW + 60 * 60_000;
  await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });
  h.clock.now = NOW;

  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

  expect(await lines(h, 'laptop-1')).toEqual([
    { at: NOW + 60 * 60_000, kind: 'cleared' },
    { at: NOW + 60 * 60_000, kind: 'raised' },
  ]);
});

test('the latest rejection to arrive sets the reason, whatever the Hub clock says', async () => {
  await using h = await startHub();
  h.clock.now = NOW + 60_000;
  await push(h.hub, 'garbage', { token: 'laptop-token' });
  h.clock.now = NOW;

  await push(h.hub, report('server-1', [NOW]), { token: 'laptop-token' });

  expect((await derived(h, 'laptop-1'))?.conditions.map((c) => c.reason)).toEqual([
    'This token belongs to laptop-1, not server-1.',
  ]);
  // The Timeline keeps the reason the Condition was raised for.
  expect((await derived(h, 'laptop-1'))?.timeline[0]).toMatchObject({
    kind: 'raised',
    reason: 'The Report is not JSON.',
  });
});

test('a rejection the database cannot record is still answered as rejected', async () => {
  await using h = await startHub();
  await h.db.sql`
    CREATE FUNCTION refuse_condition() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'condition refused'; END $$
  `;
  await h.db.sql`
    CREATE TRIGGER refuse BEFORE INSERT ON conditions
    FOR EACH ROW EXECUTE FUNCTION refuse_condition()
  `;

  const invalidReport = await push(h.hub, invalid('laptop-1'), { token: 'laptop-token' });
  const otherSystem = await push(h.hub, report('server-1', [NOW]), { token: 'laptop-token' });

  expect(invalidReport.status).toBe(422);
  expect(otherSystem.status).toBe(403);
  expect(h.errors).toHaveLength(2);
});
