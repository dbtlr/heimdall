import { expect, test } from 'bun:test';

import { ACTIVITY_RANGE_MS } from '../server/activity-types.ts';
import type { ActivityEvent } from '../server/activity-types.ts';
import type { MomentSession } from '../server/pinned-moment-types.ts';
import {
  changesNear,
  MOMENT_SLACK_MS,
  momentInput,
  pinFromSearch,
  pinWithin,
  sessionsSummary,
  timeAtFraction,
} from './activity-moment.ts';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 14, 12, 0);

const stop = (at: number, system = 'server-1'): ActivityEvent => ({
  at,
  kind: 'stop',
  lasted: 4000,
  ongoing: false,
  restarts: 0,
  service: 'caddy',
  system,
});

const session = (costUsd: number | undefined): MomentSession => ({
  costUsd,
  endedAt: T,
  harness: 'codex',
  project: undefined,
  sessionId: 'a',
  source: 'codex',
  startedAt: T,
  system: 'server-1',
});

test('the changes near a moment are those within 15 minutes of it on the pinned System', () => {
  const events = [
    stop(T - 16 * MIN),
    stop(T - 15 * MIN),
    stop(T + 15 * MIN),
    stop(T + 16 * MIN),
    stop(T, 'laptop-1'),
  ];
  expect(changesNear(events, { at: T, system: 'server-1' }).map((event) => event.at)).toEqual([
    T - 15 * MIN,
    T + 15 * MIN,
  ]);
  expect(changesNear(events, { at: T, system: undefined })).toHaveLength(3);
});

test('the summary names the Sessions and their list price, and the ones it cannot price', () => {
  expect(sessionsSummary([])).toBe('0 Sessions running');
  expect(sessionsSummary([session(2.17)])).toBe('1 Session running · $2.17 list price');
  expect(sessionsSummary([session(1), session(undefined)])).toBe(
    '2 Sessions running · $1.00 list price, 1 unpriced',
  );
});

test('a drag position becomes a minute inside the window, held to its edges', () => {
  const window = { from: T, to: T + 60 * MIN };
  expect(timeAtFraction(0.5, window)).toBe(T + 30 * MIN);
  expect(timeAtFraction(-1, window)).toBe(T);
  expect(timeAtFraction(2, window)).toBe(T + 60 * MIN);
  expect(timeAtFraction(0.5001, window) % MIN).toBe(0);
});

test('the pin in the URL is a time and the System it was pinned on, or nothing', () => {
  expect(pinFromSearch({ pin: '1700000000000', pinOn: 'server-1' })).toEqual({
    at: 1_700_000_000_000,
    system: 'server-1',
  });
  expect(pinFromSearch({ pin: 'soon' })).toBeUndefined();
  expect(pinFromSearch({ pinOn: 'server-1' })).toBeUndefined();
});

const pin = (at: number) => ({ at, system: 'server-1' });

test('a pin off the shown window is no pin', () => {
  const window = { from: T - 60 * MIN, to: T };
  expect(pinWithin(pin(T - 60 * MIN), window)).toEqual(pin(T - 60 * MIN));
  expect(pinWithin(pin(T), window)).toEqual(pin(T));
  expect(pinWithin(pin(T - 61 * MIN), window)).toBeUndefined();
  expect(pinWithin(pin(T + MIN), window)).toBeUndefined();
  expect(pinWithin(undefined, window)).toBeUndefined();
});

test('the pinned-moment read takes a time within the longest Activity range and a day of slack, and no older', () => {
  const DAY = 24 * 60 * MIN;
  const oldest = T - 30 * DAY - MOMENT_SLACK_MS;
  expect(momentInput({ at: oldest, system: 'server-1' }, T)).toEqual({
    at: oldest,
    system: 'server-1',
  });
  expect(momentInput({ at: T, system: 5 }, T)).toEqual({ at: T, system: undefined });
  expect(() => momentInput({ at: oldest - 1 }, T)).toThrow(RangeError);
  expect(() => momentInput({ at: 0 }, T)).toThrow(RangeError);
  expect(() => momentInput({ at: 'soon' }, T)).toThrow(TypeError);
});

test('a pin at the start of the 30 d window still reads after the page has been open a while', () => {
  const loadedAt = T;
  const from = loadedAt - ACTIVITY_RANGE_MS['30d'];
  // The left edge of the axis, as a drag past it pins.
  const at = timeAtFraction(-0.5, { from, to: loadedAt });
  const window = { from, to: loadedAt };
  expect(pinWithin(pin(at), window)).toEqual(pin(at));
  for (const later of [5_000, 30 * MIN, 12 * 60 * MIN]) {
    expect(momentInput(pin(at), loadedAt + later)).toEqual(pin(at));
  }
});
