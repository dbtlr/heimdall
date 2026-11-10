import { describe, expect, test } from 'bun:test';

import {
  isRunning,
  localDays,
  RUNNING_MS,
  runningChip,
  shownRunning,
  usualByNow,
} from './home-agents.ts';

const HOUR = 3_600_000;

describe('localDays', () => {
  test('in a zone behind UTC, each day runs from local midnight to the next, its cutoff the time of day now', () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const days = localDays(now, 'America/New_York', 7);

    expect(days).toHaveLength(7);
    expect(days.at(-1)).toEqual({
      cutoff: now,
      end: Date.UTC(2026, 9, 7, 4),
      start: Date.UTC(2026, 9, 6, 4),
    });
    expect(days[0]).toEqual({
      cutoff: Date.UTC(2026, 8, 30, 12),
      end: Date.UTC(2026, 9, 1, 4),
      start: Date.UTC(2026, 8, 30, 4),
    });
  });

  test('in a zone ahead of UTC, today is the local date, which UTC has not reached', () => {
    const now = Date.UTC(2026, 9, 6, 20);
    const [yesterday, today] = localDays(now, 'Asia/Tokyo', 2);

    expect(today).toEqual({
      cutoff: now,
      end: Date.UTC(2026, 9, 7, 15),
      start: Date.UTC(2026, 9, 6, 15),
    });
    expect(yesterday).toEqual({
      cutoff: Date.UTC(2026, 9, 5, 20),
      end: Date.UTC(2026, 9, 6, 15),
      start: Date.UTC(2026, 9, 5, 15),
    });
  });

  test('across a daylight-saving change, the long day has 25 hours and each cutoff keeps the wall-clock time', () => {
    // Berlin leaves summer time at 03:00 on 25 October 2026; now is 12:00 CET on the 27th.
    const now = Date.UTC(2026, 9, 27, 11);
    const [summer, change, winter] = localDays(now, 'Europe/Berlin', 4);

    expect(summer).toEqual({
      cutoff: Date.UTC(2026, 9, 24, 10),
      end: Date.UTC(2026, 9, 24, 22),
      start: Date.UTC(2026, 9, 23, 22),
    });
    expect(change).toEqual({
      cutoff: Date.UTC(2026, 9, 25, 11),
      end: Date.UTC(2026, 9, 25, 23),
      start: Date.UTC(2026, 9, 24, 22),
    });
    expect(change && change.end - change.start).toBe(25 * HOUR);
    expect(winter?.start).toBe(Date.UTC(2026, 9, 25, 23));
  });

  test('a day whose midnight is skipped starts at its first instant, as the Agents page does', () => {
    // Santiago skips from 00:00 to 01:00 on 6 September 2026.
    const [day] = localDays(Date.UTC(2026, 8, 6, 12), 'America/Santiago', 1);

    expect(day?.start).toBe(Date.UTC(2026, 8, 6, 4));
  });
});

// An earlier day: what it spent by now, and how many requests it had.
const day = (byNowUsd: number, requests = 1) => ({ byNowUsd, requests });

describe('usualByNow', () => {
  test('is the middle value over an odd count of days with requests', () => {
    expect(usualByNow([day(5), day(1), day(9)])).toBe(5);
  });

  test('is the mean of the two middle values over an even count', () => {
    expect(usualByNow([day(4), day(1), day(10), day(6)])).toBe(5);
  });

  test('leaves out days with no request, rather than counting them as nothing spent', () => {
    expect(usualByNow([day(0, 0), day(0, 0), day(3), day(7), day(8), day(0, 0)])).toBe(7);
  });

  test('counts a day with requests but nothing spent by now', () => {
    expect(usualByNow([day(0), day(2), day(4)])).toBe(2);
  });

  test('is undefined with fewer than 3 days with requests', () => {
    expect(usualByNow([day(3), day(4), day(0, 0), day(0, 0)])).toBeUndefined();
  });
});

describe('isRunning', () => {
  test('a Session whose latest request is RUNNING_MS old is running, and one a millisecond older is not', () => {
    const now = 10 * RUNNING_MS;

    expect(RUNNING_MS).toBe(5 * 60_000);
    expect(isRunning(now - RUNNING_MS, now)).toBe(true);
    expect(isRunning(now - RUNNING_MS - 1, now)).toBe(false);
  });
});

const session = (sessionId: string, lastRequestAt: number, over = {}) => ({
  harness: 'claude-code',
  lastRequestAt,
  sessionId,
  source: 'claude-code',
  system: 'server-1',
  ...over,
});

describe('shownRunning', () => {
  test('shows the 5 with the newest request first and counts the rest', () => {
    const running = [1, 7, 3, 6, 2, 5, 4].map((t) => session(`s${String(t)}`, t));

    const { more, shown } = shownRunning(running);

    expect(shown.map(({ sessionId }) => sessionId)).toEqual(['s7', 's6', 's5', 's4', 's3']);
    expect(more).toBe(2);
  });

  test('with 5 or fewer, shows them all and none more', () => {
    expect(shownRunning([session('a', 1), session('b', 2)])).toEqual({
      more: 0,
      shown: [session('b', 2), session('a', 1)],
    });
  });
});

describe('runningChip', () => {
  test('names the one Harness every running Session on the System shares', () => {
    const running = [
      session('a', 1),
      session('b', 2),
      session('c', 3, { harness: 'codex', system: 'server-2' }),
    ];

    expect(runningChip(running, 'server-1')).toEqual({ count: 2, harness: 'claude-code' });
  });

  test('names no Harness when the running Sessions on the System are of more than one', () => {
    const running = [session('a', 1), session('b', 2, { harness: 'codex' })];

    expect(runningChip(running, 'server-1')).toEqual({ count: 2, harness: undefined });
  });

  test('is undefined when no Session runs on the System', () => {
    expect(runningChip([session('a', 1)], 'server-2')).toBeUndefined();
  });
});
