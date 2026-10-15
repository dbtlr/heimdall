import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';

import { readFleetTimeline } from './fleet-timeline.ts';

beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const { addCondition } = timeline(NOW);

test('fleet Timeline keeps occurrences across Systems newest first and their transitions in recording order', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  const old = await addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'note',
    raisedAt: -800_000,
    subject: '/',
    system: 'server-1',
    transitions: [
      { at: -30, level: 'warning' },
      { at: -30, level: 'alert' },
    ],
  });
  const recent = await addCondition(h.db.sql, {
    backfilled: true,
    clearedAt: -10,
    kind: 'service_down',
    raisedAt: -100,
    subject: 'web',
    system: 'laptop-1',
  });
  await addCondition(h.db.sql, {
    clearedAt: -700_000,
    kind: 'drift',
    raisedAt: -900_000,
    system: 'server-1',
  });
  const result = await readFleetTimeline(h.db.sql, { now: NOW });
  expect(result.entries.map(({ id, system }) => ({ id, system }))).toEqual([
    { id: recent, system: 'laptop-1' },
    { id: old, system: 'server-1' },
  ]);
  expect(
    result.entries[0]?.transitions.map(({ kind, backfilled }) => ({ backfilled, kind })),
  ).toEqual([
    { backfilled: true, kind: 'raised' },
    { backfilled: true, kind: 'cleared' },
  ]);
  expect(result.entries[1]?.transitions.map(({ kind, level }) => ({ kind, level }))).toEqual([
    { kind: 'raised', level: 'note' },
    { kind: 'level_changed', level: 'warning' },
    { kind: 'level_changed', level: 'alert' },
  ]);
});

test('fleet Timeline includes retained unpaired history and returns an empty list for a new fleet', async () => {
  await using h = await startHub();
  expect((await readFleetTimeline(h.db.sql, { now: NOW })).entries).toEqual([]);
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await addCondition(h.db.sql, {
    kind: 'low_disk',
    raisedAt: -10,
    subject: '/',
    system: 'server-1',
  });
  await unpair(h.db.sql, 'server-1');
  const result = await readFleetTimeline(h.db.sql, { now: NOW });
  expect(result.entries.map(({ paired, system }) => ({ paired, system }))).toEqual([
    { paired: false, system: 'server-1' },
  ]);
});

test('a clock step backward does not reorder newly recorded occurrences', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  const first = await addCondition(h.db.sql, {
    kind: 'low_disk',
    raisedAt: -10,
    subject: '/a',
    system: 'server-1',
  });
  const later = await addCondition(h.db.sql, {
    kind: 'low_disk',
    raisedAt: -20,
    subject: '/b',
    system: 'server-1',
  });
  expect((await readFleetTimeline(h.db.sql, { now: NOW })).entries.map(({ id }) => id)).toEqual([
    later,
    first,
  ]);
});
