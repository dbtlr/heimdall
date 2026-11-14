import { describe, expect, spyOn, test } from 'bun:test';

import type { JobRun } from '../server/system-detail-types.ts';
import { dueWords, jobStrip, jobsSummary, latestRunWords, scheduleZone } from './jobs.ts';
import { phraseText } from './phrase.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 2026-11-14 00:00 UTC, a Saturday.
const DAY_14 = Date.UTC(2026, 10, 14);

const daily3 = [{ hour: 3, minute: 0 }];

// A run of the daily job started `late` after 03:00 on November `day`.
const run = (day: number, { exitStatus = 0, late = 0 } = {}): JobRun => {
  const started = Date.UTC(2026, 10, day, 3) + late;
  return { exitStatus, finished: started + MINUTE, started };
};

const strip = (runs: JobRun[], now: number, extra: { limit?: number } = {}) =>
  jobStrip({
    graceMs: HOUR,
    notBefore: Date.UTC(2026, 10, 10),
    now,
    runs,
    schedule: daily3,
    timeZone: 'UTC',
    ...extra,
  });

const kinds = (cells: { kind: string }[]) => cells.map(({ kind }) => kind);

describe('a job strip', () => {
  test('puts a missed run among the runs, oldest first, and marks a failed run', () => {
    const cells = strip([run(10), run(11, { exitStatus: 1 }), run(13)], DAY_14 + 2 * HOUR);

    expect(kinds(cells)).toEqual(['ok', 'failed', 'missed', 'ok']);
    expect(cells[2]?.at).toBe(Date.UTC(2026, 10, 12, 3));
  });

  test('counts a scheduled time as missed only once its grace period has passed with no run', () => {
    const runs = [run(10), run(11), run(12), run(13)];

    expect(kinds(strip(runs, DAY_14 + 3 * HOUR + 30 * MINUTE))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(kinds(strip(runs, DAY_14 + 4 * HOUR + MINUTE))).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'missed',
    ]);
  });

  test('takes a run that started late within the grace period as the scheduled run', () => {
    const cells = strip([run(13, { late: 59 * MINUTE })], DAY_14 + DAY / 2);

    expect(kinds(cells)).toEqual(['missed', 'missed', 'missed', 'ok', 'missed']);
  });

  test('takes a run started on waking, after the grace period but before the next time, as the scheduled run', () => {
    // A laptop asleep from 01:00 to 08:00 each night: launchd starts the 03:00
    // run when it wakes, and the Hub, counting awake time, raises no Job overdue.
    const runs = Array.from({ length: 14 }, (_, index) =>
      run(index + 1, { late: 5 * HOUR + MINUTE }),
    );

    const cells = jobStrip({
      graceMs: HOUR,
      notBefore: Date.UTC(2026, 10, 1),
      now: DAY_14 + 12 * HOUR,
      runs,
      schedule: daily3,
      timeZone: 'UTC',
    });

    expect(kinds(cells)).toEqual(Array(14).fill('ok'));
  });

  test('lets a grace period longer than the schedule answer the time before the next', () => {
    const hourly = [{ minute: 0 }];
    const cells = jobStrip({
      graceMs: 3 * HOUR,
      notBefore: DAY_14,
      now: DAY_14 + 6 * HOUR,
      runs: [
        {
          exitStatus: 0,
          finished: DAY_14 + 2 * HOUR + 30 * MINUTE,
          started: DAY_14 + 2 * HOUR + 30 * MINUTE,
        },
      ],
      schedule: hourly,
      timeZone: 'UTC',
    });

    // 00:00 to 02:00 are answered by the run at 02:30, within 3 h of each;
    // 03:00 is the last whose grace has passed.
    expect(cells.map(({ at, kind }) => [(at - DAY_14) / MINUTE, kind])).toEqual([
      [150, 'ok'],
      [180, 'missed'],
    ]);
  });

  test('looks at no more scheduled times than its cells need when the schedule fires every minute', () => {
    const everyMinute = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday }));
    const conversions = spyOn(Temporal.PlainDateTime.prototype, 'toZonedDateTime');

    const cells = jobStrip({
      graceMs: HOUR,
      notBefore: DAY_14 - 90 * DAY,
      now: DAY_14 + 12 * HOUR,
      runs: [run(13)],
      schedule: everyMinute,
      timeZone: 'UTC',
    });
    const looked = conversions.mock.calls.length;
    conversions.mockRestore();

    expect(kinds(cells)).toEqual(Array(14).fill('missed'));
    // About three days of minutes, not 90.
    expect(looked).toBeLessThan(5 * 1440);
  });

  test('keeps only the newest cells when there are more than the limit', () => {
    const cells = strip([run(10), run(11), run(12), run(13)], DAY_14 + 5 * HOUR, { limit: 3 });

    expect(cells.map(({ at }) => at)).toEqual([
      Date.UTC(2026, 10, 12, 3),
      Date.UTC(2026, 10, 13, 3),
      Date.UTC(2026, 10, 14, 3),
    ]);
    expect(kinds(cells)).toEqual(['ok', 'ok', 'missed']);
  });

  test('shows only the runs when the System has no known zone', () => {
    const cells = jobStrip({
      graceMs: HOUR,
      notBefore: DAY_14 - 5 * DAY,
      now: DAY_14 + DAY,
      runs: [run(10)],
      schedule: daily3,
      timeZone: null,
    });

    expect(kinds(cells)).toEqual(['ok']);
  });
});

describe('scheduleZone', () => {
  test("names the System's zone only when the viewer's differs", () => {
    expect(scheduleZone('UTC', 'Europe/Paris')).toBe(' UTC');
    expect(scheduleZone('UTC', 'UTC')).toBe('');
    expect(scheduleZone(null, 'UTC')).toBe('');
  });
});

describe('latestRunWords and dueWords', () => {
  const now = Date.UTC(2026, 10, 14, 12);

  test('says when the latest run started, how long it took, and its exit status', () => {
    const latestRun = { exitStatus: 1, finished: now - HOUR + 252_000, started: now - HOUR };

    expect(phraseText(latestRunWords({ latestRun }, now) ?? [], 'UTC')).toBe(
      '11:00 · 4 min · exit 1',
    );
    expect(latestRunWords({ latestRun: undefined }, now)).toBeUndefined();
  });

  test('says when a job is next due, and for an overdue job when it was due and its grace', () => {
    const base = { graceMinutes: 30, nextDue: now + 15 * HOUR, wasDueAt: now - 12 * HOUR };

    expect(phraseText(dueWords({ ...base, state: 'ok' }, now), 'UTC')).toBe('Sun 03:00');
    expect(phraseText(dueWords({ ...base, state: 'overdue' }, now), 'UTC')).toBe(
      'was due 00:00 · grace 30 min',
    );
    expect(dueWords({ ...base, nextDue: undefined, state: 'ok' }, now)).toEqual(['unknown']);
  });
});

describe('jobsSummary', () => {
  test('counts the jobs and Systems, and the failing and overdue', () => {
    expect(
      jobsSummary([
        { state: 'failing', system: 'server-1' },
        { state: 'overdue', system: 'laptop-1' },
        { state: 'ok', system: 'laptop-1' },
      ]),
    ).toBe('3 jobs on 2 Systems. 1 failing, 1 overdue.');
    expect(jobsSummary([{ state: 'ok', system: 'server-1' }])).toBe('1 job on 1 System.');
  });
});
