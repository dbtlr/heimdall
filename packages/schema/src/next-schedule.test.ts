import { expect, test } from 'bun:test';

import { nextScheduledTime } from './schedule.ts';

// Tuesday 2026-10-06 16:00 UTC.
const NOW = Date.UTC(2026, 9, 6, 16, 0);

test("a daily time later today comes today, an earlier one tomorrow, in the System's zone", () => {
  expect(
    nextScheduledTime({ after: NOW, schedule: [{ hour: 17, minute: 30 }], timeZone: 'UTC' }),
  ).toBe(Date.UTC(2026, 9, 6, 17, 30));
  expect(
    nextScheduledTime({ after: NOW, schedule: [{ hour: 3, minute: 0 }], timeZone: 'UTC' }),
  ).toBe(Date.UTC(2026, 9, 7, 3, 0));
  // 17:30 in Berlin (UTC+2 in October) is 15:30 UTC, already past.
  expect(
    nextScheduledTime({
      after: NOW,
      schedule: [{ hour: 17, minute: 30 }],
      timeZone: 'Europe/Berlin',
    }),
  ).toBe(Date.UTC(2026, 9, 7, 15, 30));
});

test('a weekly time and the earliest of several entries', () => {
  expect(
    nextScheduledTime({
      after: NOW,
      schedule: [
        { hour: 4, minute: 0, weekday: 0 },
        { hour: 4, minute: 0, weekday: 5 },
      ],
      timeZone: 'UTC',
    }),
  ).toBe(Date.UTC(2026, 9, 9, 4, 0));
});

test('no schedule, or an unknown zone, has no next time', () => {
  expect(nextScheduledTime({ after: NOW, schedule: [], timeZone: 'UTC' })).toBeUndefined();
  expect(
    nextScheduledTime({ after: NOW, schedule: [{ minute: 0 }], timeZone: 'Nowhere/Else' }),
  ).toBeUndefined();
});

test('a time a clock change skips does not hide a later time that falls first', () => {
  // New York skips 02:00 to 03:00 on 2026-03-08, so 02:30 falls at 03:30 EDT, after 03:10 EDT.
  expect(
    nextScheduledTime({
      after: Date.UTC(2026, 2, 8, 6, 0),
      schedule: [
        { hour: 2, minute: 30 },
        { hour: 3, minute: 10 },
      ],
      timeZone: 'America/New_York',
    }),
  ).toBe(Date.UTC(2026, 2, 8, 7, 10));
});
