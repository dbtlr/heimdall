import type { ConditionMark, CpuBucket, Gap, LaneStatus } from '../server/fleet-overview-types.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { spanBox } from './time.ts';
import type { Window } from './time.ts';

const BUCKET_MS = 5 * 60_000;

// One point of a lane's CPU plot: the bucket's low and high, and its average,
// or nulls where the line must break.
export type CpuPoint = { average: number | null; band: [number, number] | null; t: number };

// The CPU plot's points, one per bucket at its middle; buckets are 5 minutes
// unless `bucketMs` says otherwise. A bucket with no neighbor after it, where
// the next one is more than a bucket on, gets a null point after it, so the
// line and band do not bridge a gap. A bucket with no neighbor on either side
// spans its bucket instead, since a lone point draws nothing.
export const cpuSeries = (buckets: readonly CpuBucket[], bucketMs = BUCKET_MS): CpuPoint[] =>
  buckets.flatMap((bucket, index): CpuPoint[] => {
    const values = { average: bucket.average, band: [bucket.low, bucket.high] as [number, number] };
    const previous = buckets[index - 1];
    const next = buckets[index + 1];
    const joinsPrevious = previous !== undefined && bucket.t - previous.t <= bucketMs;
    const joinsNext = next !== undefined && next.t - bucket.t <= bucketMs;
    const points: CpuPoint[] =
      joinsPrevious || joinsNext
        ? [{ ...values, t: bucket.t + bucketMs / 2 }]
        : [
            { ...values, t: bucket.t },
            { ...values, t: bucket.t + bucketMs },
          ];
    return joinsNext ? points : [...points, { average: null, band: null, t: bucket.t + bucketMs }];
  });

// A gap's label needs about this much of the window to fit.
const MIN_LABEL_PERCENT = { asleep: 10, 'no Reports': 16 } as const;

// What a shaded gap says: "asleep" for a System that sleeps, else "no
// Reports", or nothing when the gap is too narrow to hold the words.
export const gapLabel = (
  gap: Gap,
  { sleeps, window }: { sleeps: boolean; window: Window },
): 'asleep' | 'no Reports' | undefined => {
  const label = sleeps ? 'asleep' : 'no Reports';
  return spanBox({ end: gap.to, start: gap.from }, window).width >= MIN_LABEL_PERCENT[label]
    ? label
    : undefined;
};

const STATUS_WORDS: Record<LaneStatus, string> = {
  asleep: 'Asleep',
  needs_you: 'Needs you',
  never_seen: 'Never seen',
  unpaired: 'Unpaired',
  up: 'Up',
};

export const statusWord = (status: LaneStatus): string => STATUS_WORDS[status];

const HARNESS_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const HARNESS_COLORS: Record<string, string> = {
  'claude-code': 'var(--chart-1)',
  codex: 'var(--chart-2)',
};

export const harnessName = (harness: string): string => HARNESS_NAMES[harness] ?? harness;

// The CSS variable holding the color of a Harness that has its own, or
// undefined for any other.
export const ownHarnessColor = (harness: string): string | undefined => HARNESS_COLORS[harness];

// The CSS variable holding a Harness's color: one series color per Harness,
// and the neutral one for any other.
export const harnessColor = (harness: string): string =>
  ownHarnessColor(harness) ?? 'var(--chart-3)';

// When a Condition was raised and cleared, "Tue 03:04 to 03:40", or "... to
// now" while it is open.
export const markSpan = (mark: ConditionMark, now: number): Phrase => [
  whenAt(mark.raisedAt, now),
  ' to ',
  mark.clearedAt === undefined ? 'now' : whenAt(mark.clearedAt, now),
];
