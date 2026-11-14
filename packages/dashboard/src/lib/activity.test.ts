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
} from './activity.ts';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 14, 12, 0);

const condition = (over: Partial<ConditionActivity> = {}): ConditionActivity => ({
  action: 'raised',
  at: T,
  condition: 'service_down',
  conditionId: '1',
  kind: 'condition',
  level: 'alert',
  open: true,
  previousLevel: undefined,
  raisedAt: T,
  reason: 'Exited with status 1.',
  subject: 'caddy',
  system: 'server-1',
  ...over,
});
const stop = (over: Partial<StopActivity> = {}): StopActivity => ({
  at: T,
  kind: 'stop',
  lasted: 4000,
  ongoing: false,
  restarts: 0,
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
  expect(words.detail).toBe('Exited with status 1. · caddy stopped for 4 s');
  expect(words.alert).toEqual({ at: T + MIN, recoveredAt: T + 2 * MIN });
  expect(words.open).toBe(true);
});

test('a lone alert, version change, and cleared Condition each read as one sentence', () => {
  const lone = lineWords(groupActivity([alert()])[0]!);
  expect([lone.title, lone.subject]).toEqual(['Alert sent for Service down', 'caddy']);
  expect(lineWords(groupActivity([version()])[0]!).title).toBe('ntfy 2.11.0 → 2.12.0');
  const cleared = condition({ action: 'cleared', open: false });
  const words = lineWords(groupActivity([cleared])[0]!);
  expect([words.title, words.subject, words.change]).toEqual(['Service down', 'caddy', 'cleared']);
  expect(words.open).toBe(false);
});

test('a cleared Condition says how long it lasted', () => {
  const words = lineWords(
    groupActivity([
      condition({ action: 'cleared', at: T + 18 * MIN, level: 'warning', open: false }),
    ])[0]!,
  );
  expect(words.detail).toBe('Exited with status 1. · cleared after 18 min');
  expect(words.open).toBe(false);
});

test('a level change says the levels it went between, with the level it reached on the pill', () => {
  const words = lineWords(
    groupActivity([
      condition({ action: 'level_changed', condition: 'low_disk', previousLevel: 'warning' }),
    ])[0]!,
  );
  expect([words.title, words.change, words.level]).toEqual([
    'Low disk',
    'warning → alert',
    'alert',
  ]);
});

test('each change after the lead keeps its subject and level, so two Conditions in a line stay apart', () => {
  const [line] = groupActivity([
    condition({ at: T, subject: 'caddy' }),
    condition({ at: T + MIN, conditionId: '2', subject: 'ntfy' }),
    condition({ at: T, condition: 'low_disk', conditionId: '3', level: 'warning', subject: '/' }),
  ]);
  const words = lineWords(line!);
  expect(words.subject).toBe('ntfy');
  expect(words.detail).toBe(
    'Exited with status 1. · Service down caddy (alert, open) · Low disk / (warning, open)',
  );
});

test('an alert for another Condition in the line is named, not folded into the alert-sent marker', () => {
  const [line] = groupActivity(
    filterActivity(
      [alert({ at: T }), alert({ at: T + 30_000, condition: 'low_disk', subject: '/' })],
      { kind: 'alert' },
    ),
  );
  const words = lineWords(line!);
  expect([words.title, words.subject]).toEqual(['Alert sent for Low disk', '/']);
  expect(words.alert).toEqual({ at: T + 30_000, recoveredAt: undefined });
  expect(words.detail).toBe('Alert sent for Service down caddy');
});

test("an alert for another Condition is not shown as the lead Condition's alert-sent marker", () => {
  const [line] = groupActivity([
    condition(),
    alert({ at: T + 30_000, condition: 'low_disk', subject: '/' }),
  ]);
  const words = lineWords(line!);
  expect([words.title, words.subject]).toEqual(['Service down', 'caddy']);
  expect(words.alert).toBeUndefined();
  expect(words.detail).toBe('Exited with status 1. · Alert sent for Low disk /');
});

test('the open marker belongs to the lead, and another open change says so itself', () => {
  const [line] = groupActivity([
    condition({ action: 'cleared', at: T + 2 * MIN, open: false, raisedAt: T }),
    condition({
      at: T + MIN,
      condition: 'low_disk',
      conditionId: '2',
      level: 'warning',
      subject: '/',
    }),
  ]);
  const words = lineWords(line!);
  expect(words.open).toBe(false);
  expect(words.detail).toBe(
    'Exited with status 1. · cleared after 2 min · Low disk / (warning, open)',
  );
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

test('each chip counts the lines it would show, constrained by the other filter only', () => {
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

test('the chips count merged lines, not the changes inside them', () => {
  const events: ActivityEvent[] = [
    condition({ at: T }),
    stop({ at: T + MIN }),
    version({ at: T + MIN }),
    stop({ at: T + 10 * MIN }),
    stop({ at: T + 11 * MIN }),
  ];
  const counts = activityCounts(events, {});
  expect(counts.total).toBe(groupActivity(events).length);
  expect(counts.total).toBe(2);
  // Three stops, but the last two merge into one line when only stops show.
  expect(counts.kind.stop).toBe(groupActivity(filterActivity(events, { kind: 'stop' })).length);
  expect(counts.kind.stop).toBe(2);
  expect(counts.system['server-1']).toBe(2);
});

const stopTitleOf = (over: Partial<StopActivity>) => {
  const [line] = groupActivity([stop(over)]);
  return lineWords(line!).title;
};

test('a finished stop reads as a stop with its length, and a stop under way as stopped', () => {
  expect(stopTitleOf({ lasted: 90_000 })).toBe('caddy stopped for 1 min');
  expect(stopTitleOf({ lasted: 90_000, restarts: 3 })).toBe(
    'caddy stopped for 1 min (restarted 3 times)',
  );
  expect(stopTitleOf({ lasted: undefined })).toBe('caddy stopped, end unknown');
  expect(stopTitleOf({ lasted: undefined, ongoing: true })).toBe('caddy stopped');
});

test('the search keeps a known kind, range, and System and drops the rest', () => {
  expect(activitySearch({ kind: 'stop', range: '30d', system: 'server-1' })).toMatchObject({
    kind: 'stop',
    range: '30d',
    system: 'server-1',
  });
  expect(activitySearch({ kind: 'nope', range: '1y', system: 5 })).toMatchObject({
    kind: undefined,
    range: '7d',
    system: '5',
  });
  expect(activitySearch({ pin: '1700000000000', pinOn: 'server-1' })).toMatchObject({
    pin: 1_700_000_000_000,
    pinOn: 'server-1',
  });
});
