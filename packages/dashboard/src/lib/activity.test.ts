import { expect, test } from 'bun:test';

import type {
  ActivityEvent,
  AlertActivity,
  ConditionActivity,
  StopActivity,
  VersionActivity,
} from '../server/activity-types.ts';
import {
  activityCounts,
  activitySearch,
  filterActivity,
  groupActivity,
  lineWords,
  timelineRedirect,
} from './activity.ts';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 14, 12, 0);

const condition = (over: Partial<ConditionActivity> = {}): ConditionActivity => ({
  action: 'raised',
  at: T,
  clearedAt: undefined,
  condition: 'service_down',
  conditionId: '1',
  kind: 'condition',
  level: 'alert',
  reason: 'Exited with status 1.',
  subject: 'caddy',
  system: 'server-1',
  ...over,
});
const stop = (over: Partial<StopActivity> = {}): StopActivity => ({
  at: T,
  kind: 'stop',
  ongoing: false,
  service: 'caddy',
  system: 'server-1',
  ...over,
});
const version = (over: Partial<VersionActivity> = {}): VersionActivity => ({
  at: T,
  from: '2.11.0',
  kind: 'version',
  service: 'ntfy',
  system: 'server-1',
  to: '2.12.0',
  ...over,
});
const alert = (over: Partial<AlertActivity> = {}): AlertActivity => ({
  at: T,
  condition: 'service_down',
  kind: 'alert',
  open: true,
  recoveredAt: undefined,
  subject: 'caddy',
  system: 'server-1',
  ...over,
});

test('changes on one System within 2 minutes of the first merge into one line', () => {
  const lines = groupActivity([
    condition({ at: T }),
    stop({ at: T + MIN }),
    alert({ at: T + 2 * MIN }),
  ]);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.events).toHaveLength(3);
  expect(lines[0]?.at).toBe(T + 2 * MIN);
});

test('a change more than 2 minutes after the first opens a new line, newest line first', () => {
  const lines = groupActivity([stop({ at: T }), stop({ at: T + 2 * MIN + 1, service: 'web' })]);
  expect(lines.map((line) => line.at)).toEqual([T + 2 * MIN + 1, T]);
});

test('changes on different Systems never merge', () => {
  const lines = groupActivity([stop({ at: T }), stop({ at: T, system: 'laptop-1' })]);
  expect(lines).toHaveLength(2);
});

test('a merged line leads with its Condition, then version change, stop, drift, and alert', () => {
  const [line] = groupActivity([
    alert({ at: T }),
    version({ at: T }),
    stop({ at: T }),
    condition({ at: T }),
  ]);
  expect(line?.events.map((event) => event.kind)).toEqual([
    'condition',
    'version',
    'stop',
    'alert',
  ]);
});

test('a line says its sentence, the other changes it holds, and that an alert was sent', () => {
  const [line] = groupActivity([
    condition({ at: T }),
    alert({ at: T + MIN, open: false, recoveredAt: T + 2 * MIN }),
    stop({ at: T }),
  ]);
  const words = lineWords(line!);
  expect(words.title).toBe('Service down');
  expect(words.subject).toBe('caddy');
  expect(words.level).toBe('alert');
  expect(words.detail).toBe('Exited with status 1. · caddy restarted');
  expect(words.alert).toEqual({ at: T + MIN, recoveredAt: T + 2 * MIN });
  expect(words.open).toBe(true);
});

test('a lone alert, version change, and cleared Condition each read as one sentence', () => {
  const lone = lineWords(groupActivity([alert()])[0]!);
  expect([lone.title, lone.subject]).toEqual(['Alert sent for Service down', 'caddy']);
  expect(lineWords(groupActivity([version()])[0]!).title).toBe('ntfy 2.11.0 → 2.12.0');
  const cleared = condition({ action: 'cleared', at: T, clearedAt: T });
  const words = lineWords(groupActivity([cleared])[0]!);
  expect(words.title).toBe('Service down cleared');
  expect(words.open).toBe(false);
});

test('a Condition cleared inside the window says how long it lasted', () => {
  const words = lineWords(
    groupActivity([condition({ at: T, clearedAt: T + 18 * MIN, level: 'warning' })])[0]!,
  );
  expect(words.detail).toBe('Exited with status 1. · cleared after 18 min');
  expect(words.open).toBe(false);
});

test('filters keep the kind and System chosen, and none keeps everything', () => {
  const events: ActivityEvent[] = [
    condition(),
    condition({ condition: 'drift', kind: 'drift', system: 'laptop-1' }),
    version(),
    stop(),
    alert(),
  ];
  expect(filterActivity(events, {})).toHaveLength(5);
  expect(filterActivity(events, { kind: 'drift' }).map((event) => event.system)).toEqual([
    'laptop-1',
  ]);
  expect(filterActivity(events, { system: 'server-1' })).toHaveLength(4);
  expect(filterActivity(events, { kind: 'stop', system: 'laptop-1' })).toEqual([]);
});

test('filtering by kind happens before grouping, so a hidden kind never joins a line', () => {
  const events: ActivityEvent[] = [condition(), alert({ at: T + MIN })];
  const lines = groupActivity(filterActivity(events, { kind: 'alert' }));
  expect(lines).toHaveLength(1);
  expect(lines[0]?.events.map((event) => event.kind)).toEqual(['alert']);
});

test('each chip counts what it would show, constrained by the other filter only', () => {
  const events: ActivityEvent[] = [
    condition(),
    stop(),
    stop({ system: 'laptop-1' }),
    version({ system: 'laptop-1' }),
  ];
  const counts = activityCounts(events, { kind: 'stop', system: 'laptop-1' });
  expect(counts.kind).toEqual({ alert: 0, condition: 0, drift: 0, stop: 1, version: 1 });
  expect(counts.system).toEqual({ 'laptop-1': 1, 'server-1': 1 });
});

test('the search keeps a known kind, range, and System and drops the rest', () => {
  expect(activitySearch({ kind: 'stop', range: '30d', system: 'server-1' })).toEqual({
    kind: 'stop',
    range: '30d',
    system: 'server-1',
  });
  expect(activitySearch({ kind: 'nope', range: '1y', system: 5 })).toEqual({
    kind: undefined,
    range: '7d',
    system: '5',
  });
});

test('the old Timeline address redirects to Activity, keeping its System', () => {
  expect(timelineRedirect({ level: ['alert'], status: ['open'], system: ['server-1'] })).toEqual({
    search: { system: 'server-1' },
    to: '/activity',
  });
  expect(timelineRedirect({})).toEqual({ search: {}, to: '/activity' });
});
