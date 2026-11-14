import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';

import { readActivity } from './activity.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const { addCondition, at } = timeline(NOW);
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
    INSERT INTO deliveries (system, kind, subject, alert_since, pushed_at, closed_at)
    VALUES ('server-1', 'service_down', 'caddy', ${at(ago(3 * HOUR))}, ${at(ago(3 * HOUR))}, ${at(ago(HOUR))})
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
  ]);
  expect(activity.events.find((event) => event.kind === 'alert')).toMatchObject({
    open: false,
    recoveredAt: NOW - HOUR,
  });
  expect(activity.events.find((event) => event.kind === 'condition')).toMatchObject({
    action: 'raised',
    conditionId: raised,
    level: 'alert',
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
  expect(events).toMatchObject([{ action: 'cleared', at: NOW - HOUR, kind: 'condition' }]);
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
