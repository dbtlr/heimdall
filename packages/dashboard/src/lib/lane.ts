import type {
  ConditionMark,
  CpuBucket,
  Gap,
  Lane,
  LaneStatus,
  Stretch,
} from '../server/fleet-overview-types.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import { KIND_NAMES } from './conditions.ts';
import { formatClock, formatCost, formatWhen, spanBox } from './time.ts';
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

const vitalsText = ({
  cpuBusyPercent,
  memoryUsedPercent,
}: {
  cpuBusyPercent: number;
  memoryUsedPercent: number;
}) =>
  `CPU ${String(Math.round(cpuBusyPercent))}%, memory ${String(Math.round(memoryUsedPercent))}%`;

// The line under a lane's status: its newest CPU and memory, or since when it
// has been asleep or silent, so old Vitals never read as current. An unpaired
// System sends no more, so its line dates its last Vitals.
export const nowLine = (
  lane: Lane,
  { now, timeZone }: { now: number; timeZone: string },
): string => {
  if (lane.status === 'unpaired') {
    return lane.latest === undefined
      ? 'no Vitals'
      : `last Vitals ${formatWhen(lane.latest.t, now, timeZone)}, ${vitalsText(lane.latest)}`;
  }
  if (lane.status === 'never_seen') {
    return 'never seen';
  }
  if (lane.status === 'asleep') {
    return lane.lastSeenAt === undefined
      ? 'asleep'
      : `asleep since ${formatWhen(lane.lastSeenAt, now, timeZone)}`;
  }
  if (lane.lastSeenAt !== undefined && now - lane.lastSeenAt > QUIET_AFTER_MS) {
    return `silent since ${formatWhen(lane.lastSeenAt, now, timeZone)}`;
  }
  return lane.latest === undefined ? 'no Vitals' : vitalsText(lane.latest);
};

const HARNESS_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const HARNESS_COLORS: Record<string, string> = {
  'claude-code': 'var(--chart-1)',
  codex: 'var(--chart-2)',
};

export const harnessName = (harness: string): string => HARNESS_NAMES[harness] ?? harness;

// The CSS variable holding a Harness's color: one series color per Harness,
// and the neutral one for any other.
export const harnessColor = (harness: string): string =>
  HARNESS_COLORS[harness] ?? 'var(--chart-3)';

// A Session stretch's tooltip: "fleet on main, Codex, 07:40 to 08:15, $4.05,
// process linked".
export const stretchTitle = (stretch: Stretch, timeZone: string): string => {
  const what =
    stretch.project !== undefined && stretch.branch !== undefined
      ? `${stretch.project} on ${stretch.branch}`
      : (stretch.project ?? stretch.branch ?? 'Session');
  return [
    what,
    harnessName(stretch.harness),
    `${formatClock(stretch.startedAt, timeZone)} to ${formatClock(stretch.endedAt, timeZone)}`,
    formatCost(stretch.costUsd),
    `process ${stretch.link}`,
  ].join(', ');
};

// A Condition's raised mark: "Job failing, photos-sync, since 03:04".
export const raisedTitle = (
  mark: ConditionMark,
  { now, timeZone }: { now: number; timeZone: string },
): string =>
  `${KIND_NAMES[mark.kind]}, ${mark.subject}, since ${formatWhen(mark.raisedAt, now, timeZone)}`;

// A Condition's cleared mark: "Service down cleared for ollama."
export const clearedTitle = (mark: ConditionMark): string =>
  `${KIND_NAMES[mark.kind]} cleared for ${mark.subject}.`;
