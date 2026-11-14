import { expect, test } from 'bun:test';

import type { ActivityEvent } from '../server/activity-types.ts';
import type { MomentSession } from '../server/pinned-moment-types.ts';
import {
  changesNear,
  momentTotal,
  pinFromSearch,
  sessionsSummary,
  timeAtFraction,
} from './activity-moment.ts';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 14, 12, 0);

const stop = (at: number, system = 'server-1'): ActivityEvent => ({
  at,
  kind: 'stop',
  ongoing: false,
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

test('a moment totals the cost it knows and counts the Sessions it cannot price', () => {
  expect(momentTotal([session(1.5), session(0.25), session(undefined)])).toEqual({
    unpriced: 1,
    usd: 1.75,
  });
  expect(momentTotal([])).toEqual({ unpriced: 0, usd: 0 });
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
