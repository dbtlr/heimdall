import { expect, test } from 'bun:test';

import type { ConditionMark, Lane, Stretch } from '../server/fleet-overview-types.ts';
import {
  clearedTitle,
  cpuSeries,
  gapLabel,
  harnessColor,
  markSpan,
  nowLine,
  raisedTitle,
  statusWord,
  stretchTitle,
} from './lane.ts';
import { phraseText, zoneFreeText } from './phrase.ts';
import type { Phrase } from './phrase.ts';

const MINUTE = 60_000;
const BUCKET = 5 * MINUTE;
const NOW = Date.UTC(2026, 9, 13, 16, 0, 0);

const bucket = (t: number, average = 10) => ({ average, high: average + 5, low: average - 5, t });

test('contiguous buckets make one unbroken run', () => {
  const series = cpuSeries([bucket(0), bucket(BUCKET), bucket(2 * BUCKET)]);
  expect(series.map((point) => point.t)).toEqual([
    BUCKET / 2,
    1.5 * BUCKET,
    2.5 * BUCKET,
    3 * BUCKET,
  ]);
  expect(series.slice(0, 3).every((point) => point.band !== null)).toBe(true);
});

test('a gap between buckets breaks the line', () => {
  const series = cpuSeries([bucket(0, 20), bucket(BUCKET, 30), bucket(4 * BUCKET, 40)]);
  expect(series).toEqual([
    { average: 20, band: [15, 25], t: BUCKET / 2 },
    { average: 30, band: [25, 35], t: 1.5 * BUCKET },
    { average: null, band: null, t: 2 * BUCKET },
    { average: 40, band: [35, 45], t: 4 * BUCKET },
    { average: 40, band: [35, 45], t: 5 * BUCKET },
    { average: null, band: null, t: 5 * BUCKET },
  ]);
});

test('a lone bucket draws across its 5 minutes, since one point draws nothing', () => {
  expect(cpuSeries([bucket(2 * BUCKET, 20)])).toEqual([
    { average: 20, band: [15, 25], t: 2 * BUCKET },
    { average: 20, band: [15, 25], t: 3 * BUCKET },
    { average: null, band: null, t: 3 * BUCKET },
  ]);
});

test('no buckets make no points', () => {
  expect(cpuSeries([])).toEqual([]);
});

test.each([
  [true, 10, 'asleep'],
  [true, 12, 'asleep'],
  [true, 9, undefined],
  [false, 12, undefined],
  [false, 20, 'no Reports'],
] as const)(
  'a gap of %p sleeps spanning %d%% of the window is labeled %p',
  (sleeps, percent, label) => {
    const window = { from: 0, to: 100 };
    expect(gapLabel({ from: 10, to: 10 + percent }, { sleeps, window })).toBe(label);
  },
);

test('a gap is measured where it meets the window', () => {
  const window = { from: 100, to: 200 };
  expect(gapLabel({ from: 0, to: 105 }, { sleeps: true, window })).toBeUndefined();
});

const lane = (overrides: Partial<Lane>): Lane => ({
  buckets: [],
  conditions: [],
  gaps: [],
  lastSeenAt: undefined,
  latest: undefined,
  name: 'laptop',
  sleeps: false,
  status: 'up',
  stretches: [],
  ...overrides,
});

const text = (phrase: Phrase) => phraseText(phrase, 'UTC');

test('the now line says what each status knows', () => {
  expect(
    text(
      nowLine(
        lane({
          lastSeenAt: NOW - MINUTE,
          latest: { cpuBusyPercent: 11.6, disks: [], memoryUsedPercent: 58.2, t: NOW },
        }),
        NOW,
      ),
    ),
  ).toBe('CPU 12%, memory 58%');
  expect(
    text(nowLine(lane({ lastSeenAt: Date.UTC(2026, 9, 13, 12, 48), status: 'asleep' }), NOW)),
  ).toBe('asleep since 12:48');
  expect(text(nowLine(lane({ status: 'never_seen' }), NOW))).toBe('never seen');
});

test('the now line needs no time zone unless it names a time', () => {
  const latest = { cpuBusyPercent: 11.6, disks: [], memoryUsedPercent: 58.2, t: NOW };
  expect(zoneFreeText(nowLine(lane({ lastSeenAt: NOW - MINUTE, latest }), NOW))).toBe(
    'CPU 12%, memory 58%',
  );
  expect(zoneFreeText(nowLine(lane({ status: 'never_seen' }), NOW))).toBe('never seen');
  expect(zoneFreeText(nowLine(lane({ status: 'unpaired' }), NOW))).toBe('never seen');
  expect(zoneFreeText(nowLine(lane({ lastSeenAt: NOW, status: 'asleep' }), NOW))).toBeUndefined();
});

test('the now line of an unpaired System leads with when it was last seen, then its Vitals', () => {
  const latest = {
    cpuBusyPercent: 17.6,
    disks: [],
    memoryUsedPercent: 41.2,
    t: Date.UTC(2026, 9, 13, 4, 35),
  };
  expect(
    text(
      nowLine(lane({ lastSeenAt: Date.UTC(2026, 9, 13, 4, 36), latest, status: 'unpaired' }), NOW),
    ),
  ).toBe('last seen 04:36, CPU 18%, memory 41%');
});

test('the now line of an unpaired System seen without a sample still has its date', () => {
  expect(
    text(nowLine(lane({ lastSeenAt: Date.UTC(2026, 9, 13, 4, 36), status: 'unpaired' }), NOW)),
  ).toBe('last seen 04:36, no Vitals');
  expect(text(nowLine(lane({ status: 'unpaired' }), NOW))).toBe('never seen');
});

test('the now line of a System silent over 2 minutes says since when, not old Vitals', () => {
  const latest = {
    cpuBusyPercent: 11.6,
    disks: [],
    memoryUsedPercent: 58.2,
    t: NOW - 6 * 60 * MINUTE,
  };
  const silent = lane({ lastSeenAt: NOW - 6 * 60 * MINUTE, latest, status: 'needs_you' });
  expect(text(nowLine(silent, NOW))).toBe('silent since 10:00');
});

test('a status reads as a word', () => {
  expect(statusWord('needs_you')).toBe('Needs you');
  expect(statusWord('never_seen')).toBe('Never seen');
  expect(statusWord('unpaired')).toBe('Unpaired');
});

const stretch: Stretch = {
  branch: 'main',
  costUsd: 4.05,
  endedAt: Date.UTC(2026, 9, 13, 8, 15),
  harness: 'claude-code',
  link: 'linked',
  project: 'fleet',
  sessionId: 's1',
  startedAt: Date.UTC(2026, 9, 13, 7, 40),
};

test('a stretch title names its project, Harness, times, cost, and link', () => {
  expect(text(stretchTitle(stretch))).toBe(
    'fleet on main, Claude Code, 07:40 to 08:15, $4.05, process linked',
  );
  expect(
    text(
      stretchTitle({
        ...stretch,
        branch: undefined,
        costUsd: undefined,
        harness: 'codex',
        link: 'ambiguous',
        project: undefined,
      }),
    ),
  ).toBe('Session, Codex, 07:40 to 08:15, cost unknown, process ambiguous');
});

test('a Harness has its color, and an unknown one the neutral one', () => {
  expect(harnessColor('claude-code')).toBe('var(--chart-1)');
  expect(harnessColor('codex')).toBe('var(--chart-2)');
  expect(harnessColor('aider')).toBe('var(--chart-3)');
});

test('a Condition mark spans from raised to cleared, or to now while open', () => {
  const mark: ConditionMark = {
    clearedAt: Date.UTC(2026, 9, 13, 3, 40),
    id: '1',
    kind: 'job_failing',
    level: 'alert',
    raisedAt: Date.UTC(2026, 9, 13, 3, 4),
    subject: 'photos-sync',
    transitions: [],
  };
  expect(text(markSpan(mark, NOW))).toBe('03:04 to 03:40');
  expect(text(markSpan({ ...mark, raisedAt: mark.raisedAt - 24 * 60 * MINUTE }, NOW))).toBe(
    'Mon 03:04 to 03:40',
  );
  expect(text(markSpan({ ...mark, clearedAt: undefined }, NOW))).toBe('03:04 to now');
});

test('condition mark titles name the kind and subject', () => {
  const mark: ConditionMark = {
    clearedAt: undefined,
    id: '2',
    kind: 'job_failing',
    level: 'alert',
    raisedAt: Date.UTC(2026, 9, 13, 3, 4),
    subject: 'photos-sync',
    transitions: [],
  };
  expect(text(raisedTitle(mark, NOW))).toBe('Job failing, photos-sync, since 03:04');
  expect(clearedTitle({ ...mark, kind: 'service_down', subject: 'ollama' })).toBe(
    'Service down cleared for ollama.',
  );
});
