import { describe, expect, test } from 'bun:test';

import type { ConditionMark } from '../server/fleet-overview-types.ts';
import type { ServiceChange } from '../server/home-types.ts';
import {
  binMarkPercent,
  changeCounts,
  costBars,
  foldQuietProcesses,
  kindRows,
} from './long-history.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 2 Nov 2026, 00:00 UTC.
const MONDAY = Date.UTC(2026, 10, 2);
const NOW = MONDAY + 14 * DAY;
const YEAR = { from: NOW - 365 * DAY, to: NOW };

const mark = (overrides: Partial<ConditionMark> & Pick<ConditionMark, 'kind'>): ConditionMark => ({
  clearedAt: undefined,
  id: `${overrides.kind}-${String(overrides.raisedAt)}`,
  level: 'warning',
  raisedAt: NOW - HOUR,
  subject: '',
  transitions: [],
  ...overrides,
});

const version = (at: number, service = 'web'): ServiceChange => ({
  at,
  from: '1.8.2',
  kind: 'version',
  service,
  system: 'server-1',
  to: '1.8.3',
});

describe('costBars', () => {
  test("stack each bucket's cost by Harness, Claude Code first, with the bucket's total", () => {
    expect(
      costBars([
        { costUsd: 4, harness: 'codex', t: MONDAY, unpriced: 0 },
        { costUsd: 6, harness: 'claude-code', t: MONDAY, unpriced: 1 },
        { costUsd: 2, harness: 'claude-code', t: MONDAY + DAY, unpriced: 0 },
      ]),
    ).toEqual([
      {
        parts: [
          { costUsd: 6, harness: 'claude-code' },
          { costUsd: 4, harness: 'codex' },
        ],
        t: MONDAY,
        totalUsd: 10,
        unpriced: 1,
      },
      {
        parts: [{ costUsd: 2, harness: 'claude-code' }],
        t: MONDAY + DAY,
        totalUsd: 2,
        unpriced: 0,
      },
    ]);
  });
});

describe('changeCounts', () => {
  test('count Service changes per Monday-started week over a year', () => {
    expect(
      changeCounts(
        {
          changes: [
            version(MONDAY + HOUR),
            version(MONDAY + 3 * DAY, 'db'),
            version(MONDAY + 8 * DAY),
          ],
          conditions: [],
          paired: true,
        },
        YEAR,
        [MONDAY - 7 * DAY, MONDAY, MONDAY + 7 * DAY, MONDAY + 14 * DAY + HOUR],
      ),
    ).toEqual([
      { count: 2, end: MONDAY + 7 * DAY, t: MONDAY },
      { count: 1, end: MONDAY + 14 * DAY + HOUR, t: MONDAY + 7 * DAY },
    ]);
  });

  test('count per day over 30 days, a stop folded into its version change counting once', () => {
    const at = MONDAY + 10 * HOUR;
    expect(
      changeCounts(
        {
          changes: [
            version(at),
            {
              at: at + 60_000,
              kind: 'stop',
              lasted: 4000,
              ongoing: false,
              restarts: 0,
              service: 'web',
              system: 'server-1',
            },
          ],
          conditions: [],
          paired: true,
        },
        { from: NOW - 30 * DAY, to: NOW },
        [MONDAY - DAY, MONDAY, MONDAY + DAY],
      ),
    ).toEqual([{ count: 1, end: MONDAY + DAY, t: MONDAY }]);
  });

  test('count by the local days the edges give, a 25-hour day as one', () => {
    // 1 Nov 2026 in Los Angeles: 07:00 UTC to 08:00 UTC the next day.
    const day = Date.UTC(2026, 10, 1, 7);
    expect(
      changeCounts(
        {
          changes: [version(day + 30 * 60_000), version(day + 24.5 * HOUR)],
          conditions: [],
          paired: true,
        },
        { from: day - DAY, to: day + 2 * DAY },
        [day, day + 25 * HOUR, day + 49 * HOUR],
      ),
    ).toEqual([{ count: 2, end: day + 25 * HOUR, t: day }]);
  });
});

describe('binMarkPercent', () => {
  const window = { from: 1000, to: 2000 };

  test("sits in the middle of a bin's part inside the window", () => {
    expect(binMarkPercent({ end: 1400, t: 1200 }, window)).toBe(30);
    // Today's bin runs past now, and the first bin starts before the window.
    expect(binMarkPercent({ end: 2600, t: 1800 }, window)).toBe(90);
    expect(binMarkPercent({ end: 1200, t: 400 }, window)).toBe(10);
  });
});

// A process with one point per cores figure, a millisecond apart.
const series = (processId: number, cores: (number | null)[]) => ({
  harness: 'codex',
  pid: processId,
  points: cores.map((value, index) => ({ cores: value, t: index })),
  processId,
  project: undefined,
});

describe('foldQuietProcesses', () => {
  test('keep the busiest by name and sum the rest into one series', () => {
    const folded = foldQuietProcesses(
      [series(1, [0.1, null]), series(2, [2, 2]), series(3, [0.2, 0.3]), series(4, [1, 1])],
      2,
    );
    expect(folded.map(({ processId }) => processId)).toEqual([2, 4, 0]);
    expect(folded[2]).toMatchObject({ harness: 'other', pid: 0, project: '2 other processes' });
    expect(folded[2]?.points.map(({ cores }) => cores)).toEqual([0.30000000000000004, 0.3]);
  });

  test('fold nothing when there are no more than it shows', () => {
    expect(foldQuietProcesses([series(1, [1])], 8)).toHaveLength(1);
  });
});

describe('kindRows', () => {
  test('fold the Conditions into one row per kind, the most frequent first, with its count', () => {
    const rows = kindRows(
      [
        mark({ clearedAt: NOW - 90 * DAY, kind: 'high_cpu', raisedAt: NOW - 91 * DAY }),
        mark({ kind: 'service_down', level: 'alert', raisedAt: NOW - 40 * DAY, subject: 'web' }),
        mark({ clearedAt: NOW - 9 * DAY, kind: 'high_cpu', raisedAt: NOW - 10 * DAY }),
        mark({ kind: 'low_disk', raisedAt: NOW - 2 * DAY, subject: '/data' }),
        // Before the year: off the lane.
        mark({ clearedAt: NOW - 400 * DAY, kind: 'clock_skew', raisedAt: NOW - 401 * DAY }),
      ],
      { paired: true, window: YEAR },
    );
    expect(rows.map(({ count, kind, name }) => ({ count, kind, name }))).toEqual([
      { count: 2, kind: 'high_cpu', name: 'High CPU' },
      { count: 1, kind: 'low_disk', name: 'Low disk' },
      { count: 1, kind: 'service_down', name: 'Service down' },
    ]);
    expect(rows[0]?.marks.map(({ raisedAt }) => raisedAt)).toEqual([
      NOW - 91 * DAY,
      NOW - 10 * DAY,
    ]);
  });
});
