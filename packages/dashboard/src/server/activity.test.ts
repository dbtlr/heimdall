import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

import { axisBucketMs } from './activity-axis.ts';
import { readActivity } from './activity.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const { addCondition, addSession, addVitals, at } = timeline(NOW);
// The Condition fixtures count seconds from NOW.
const ago = (ms: number) => -ms / 1000;

test('Activity reads every kind of change in the window, and nothing outside it', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  const { sql } = h.db;
  const raised = await addCondition(sql, {
    kind: 'service_down',
    raisedAt: ago(3 * HOUR),
    subject: 'caddy',
    system: 'server-1',
  });
  await addCondition(sql, {
    clearedAt: ago(HOUR),
    kind: 'drift',
    raisedAt: ago(2 * DAY),
    subject: '/etc/caddy/Caddyfile',
    system: 'laptop-1',
  });
  // Outside the window, and shown on Maintenance rather than here.
  await addCondition(sql, { kind: 'low_disk', raisedAt: ago(9 * DAY), system: 'server-1' });
  await addCondition(sql, {
    kind: 'pending_update',
    level: 'note',
    raisedAt: ago(HOUR),
    subject: 'apt',
    system: 'server-1',
  });
  await sql`
    INSERT INTO service_versions (system, service, version, upstream, first_seen_at) VALUES
      ('server-1', 'ntfy', '2.11.0', NULL, ${at(ago(20 * DAY))}),
      ('server-1', 'ntfy', '2.12.0', NULL, ${at(ago(2 * HOUR))})
  `;
  await sql`
    INSERT INTO service_stops (system, service, stopped_at, ongoing, restarts, sent_at, received_at)
    VALUES ('server-1', 'caddy', ${at(ago(3 * HOUR))}, true, 0, ${at(0)}, ${at(0)})
  `;
  await sql`
    INSERT INTO deliveries (system, kind, subject, alert_since, pushed_at, closed_at, recovered_at)
    VALUES ('server-1', 'service_down', 'caddy', ${at(ago(3 * HOUR))}, ${at(ago(3 * HOUR))},
            ${at(ago(HOUR))}, ${at(ago(HOUR))})
  `;

  const activity = await readActivity(sql, { now: NOW, range: '7d' });

  expect(
    activity.events
      .map(({ at: time, kind, system }) => ({ kind, system, time }))
      .toSorted((a, b) => a.time - b.time || a.kind.localeCompare(b.kind)),
  ).toEqual([
    { kind: 'drift', system: 'laptop-1', time: NOW - 2 * DAY },
    { kind: 'alert', system: 'server-1', time: NOW - 3 * HOUR },
    { kind: 'condition', system: 'server-1', time: NOW - 3 * HOUR },
    { kind: 'stop', system: 'server-1', time: NOW - 3 * HOUR },
    { kind: 'version', system: 'server-1', time: NOW - 2 * HOUR },
    { kind: 'drift', system: 'laptop-1', time: NOW - HOUR },
  ]);
  expect(activity.events.find((event) => event.kind === 'alert')).toMatchObject({
    open: false,
    recoveredAt: NOW - HOUR,
  });
  expect(activity.events.find((event) => event.kind === 'condition')).toMatchObject({
    action: 'raised',
    conditionId: raised,
    level: 'alert',
    open: true,
  });
  expect(activity.systems).toEqual(['laptop-1', 'server-1']);
});

test('a Condition raised before the window and cleared in it is listed as cleared', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await addCondition(h.db.sql, {
    clearedAt: ago(HOUR),
    kind: 'low_disk',
    raisedAt: ago(3 * DAY),
    subject: '/',
    system: 'server-1',
  });
  const { events } = await readActivity(h.db.sql, { now: NOW, range: '24h' });
  expect(events).toMatchObject([
    { action: 'cleared', at: NOW - HOUR, kind: 'condition', open: false, raisedAt: NOW - 3 * DAY },
  ]);
});

test('each level change is listed at its time, and each transition carries the level it reached then', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'note',
    raisedAt: ago(5 * HOUR),
    subject: '/',
    system: 'server-1',
    transitions: [{ at: ago(HOUR), level: 'alert' }],
  });
  // Raised before the window, it changed level inside it.
  await addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'warning',
    raisedAt: ago(3 * DAY),
    subject: '/data',
    system: 'server-1',
    transitions: [{ at: ago(2 * HOUR), level: 'alert' }],
  });
  const { events } = await readActivity(h.db.sql, { now: NOW, range: '24h' });
  expect(
    events
      .flatMap((event) =>
        event.kind === 'condition'
          ? [[event.subject, event.action, event.previousLevel, event.level, event.at]]
          : [],
      )
      .toSorted((a, b) => Number(a[4]) - Number(b[4])),
  ).toEqual([
    ['/', 'raised', undefined, 'note', NOW - 5 * HOUR],
    ['/data', 'level_changed', 'warning', 'alert', NOW - 2 * HOUR],
    ['/', 'level_changed', 'note', 'alert', NOW - HOUR],
  ]);
});

test('a maintenance Condition raised as a warning stays listed after it falls to a note', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await addCondition(h.db.sql, {
    kind: 'reboot_required',
    level: 'warning',
    raisedAt: ago(5 * HOUR),
    system: 'server-1',
    transitions: [{ at: ago(HOUR), level: 'note' }],
  });
  const { events } = await readActivity(h.db.sql, { now: NOW, range: '24h' });
  expect(
    events.map((event) => (event.kind === 'condition' ? [event.action, event.level] : [])),
  ).toEqual([
    ['raised', 'warning'],
    ['level_changed', 'note'],
  ]);
});

test('an alert shows the recovery the Hub recorded sending, whether its System is paired now or not', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  await h.db.sql`
    INSERT INTO deliveries (system, kind, subject, alert_since, pushed_at, closed_at, recovered_at)
    VALUES
      ('server-1', 'service_down', 'a', ${at(ago(3 * HOUR))}, ${at(ago(3 * HOUR))}, ${at(ago(2 * HOUR))}, NULL),
      ('laptop-1', 'service_down', 'b', ${at(ago(3 * HOUR))}, ${at(ago(3 * HOUR))}, ${at(ago(2 * HOUR))}, ${at(ago(2 * HOUR))})
  `;
  await unpair(h.db.sql, 'laptop-1');
  const { events } = await readActivity(h.db.sql, { now: NOW, range: '24h' });
  expect(
    events.map((event) => (event.kind === 'alert' ? [event.subject, event.recoveredAt] : [])),
  ).toEqual(
    expect.arrayContaining([
      ['a', undefined],
      ['b', NOW - 2 * HOUR],
    ]),
  );
});

test("a System's Activity holds its own changes alone", async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  await addCondition(h.db.sql, { kind: 'low_disk', raisedAt: ago(HOUR), system: 'server-1' });
  await addCondition(h.db.sql, { kind: 'low_disk', raisedAt: ago(HOUR), system: 'laptop-1' });
  const activity = await readActivity(h.db.sql, { now: NOW, range: '7d', system: 'laptop-1' });
  expect(activity.events.map((event) => event.system)).toEqual(['laptop-1']);
  expect(activity.systems).toEqual(['laptop-1']);
});

test('an unpaired System keeps its Condition history, labelled unpaired', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await addCondition(h.db.sql, {
    kind: 'low_disk',
    raisedAt: ago(HOUR),
    subject: '/',
    system: 'server-1',
  });
  await unpair(h.db.sql, 'server-1');
  const activity = await readActivity(h.db.sql, { now: NOW, range: '24h' });
  expect(activity.events).toHaveLength(1);
  expect(activity.unpaired).toEqual(['server-1']);
});

// The plan for a read of `table` over a window on `column`, with sequential
// scans priced out.
const windowPlan = (sql: SQL, table: string, column: string) =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL enable_seqscan = off`;
    const rows: { 'QUERY PLAN': string }[] = await tx.unsafe(
      `EXPLAIN SELECT * FROM ${table} WHERE ${column} >= $1 AND ${column} <= $2`,
      [new Date(NOW - DAY), new Date(NOW)],
    );
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  });

// The indexes on `table` that lead with `column` and hold every row. A
// partial index, or one that leads with another column and is skipped
// through, does not find a window by time.
const timeIndexes = async (sql: SQL, table: string, column: string): Promise<string[]> => {
  const rows: { name: string }[] = await sql`
    SELECT i.relname AS name
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
    WHERE x.indrelid = ${table}::regclass AND a.attname = ${column} AND x.indpred IS NULL
  `;
  return rows.map((row) => row.name);
};

test.each([
  ['condition_transitions', 'at'],
  ['deliveries', 'pushed_at'],
  ['service_stops', 'stopped_at'],
])(
  'each window Activity reads from %s is found through an index on its time',
  async (table, column) => {
    await using h = await startHub();
    const [index] = await timeIndexes(h.db.sql, table, column);
    expect(index).toBeDefined();
    expect(await windowPlan(h.db.sql, table, column)).toMatch(new RegExp(String.raw`\b${index}\b`));
  },
);

test('the axis bucket widens with the range, so its read follows the buckets drawn', () => {
  expect([HOUR * 24, DAY * 7, DAY * 30].map(axisBucketMs)).toEqual([
    10 * 60_000,
    2 * HOUR,
    6 * HOUR,
  ]);
});

test('each System gets a lane of CPU in axis buckets and the stretches of its Sessions, with no systems row needed', async () => {
  await using h = await startHub();
  const { sql } = h.db;
  await sql`INSERT INTO systems (name) VALUES ('server-1')`;
  // Samples 2 minutes apart averaged in one 10-minute bucket, then one in the next.
  for (const minutes of [-120, -118, -116, -114, -110]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture rows.
    await addVitals(sql, 'server-1', minutes * 60, minutes === -110 ? 90 : 10 + minutes + 120);
  }
  // A Session on a System the Hub never heard a Report from.
  await addSession(sql, { id: 'solo', requests: [-3 * 3600, -3 * 3600 + 120], system: 'laptop-1' });
  await addSession(sql, {
    id: 'old',
    requests: [(-3 * DAY) / 1000, (-3 * DAY) / 1000 + 60],
    system: 'laptop-1',
  });

  const { bucketMs, lanes, systems } = await readActivity(sql, { now: NOW, range: '24h' });

  expect(bucketMs).toBe(10 * 60_000);
  expect(systems).toEqual(['laptop-1', 'server-1']);
  const [laptop, server] = lanes;
  expect(laptop?.stretches).toMatchObject([
    { endedAt: NOW - 3 * HOUR + 120_000, harness: 'claude-code', startedAt: NOW - 3 * HOUR },
  ]);
  expect(laptop?.buckets).toEqual([]);
  expect(server?.buckets.map(({ average, high, low }) => ({ average, high, low }))).toEqual([
    { average: 13, high: 16, low: 10 },
    { average: 90, high: 90, low: 90 },
  ]);
});
