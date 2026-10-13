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

// The CPU plot's points, one per bucket at its middle. A bucket with no
// neighbor after it, where the next one is more than 5 minutes on, gets a null
// point after it, so the line and band do not bridge a gap. A bucket with no
// neighbor on either side spans its 5 minutes instead, since a lone point
// draws nothing.
export const cpuSeries = (buckets: readonly CpuBucket[]): CpuPoint[] =>
  buckets.flatMap((bucket, index): CpuPoint[] => {
    const values = { average: bucket.average, band: [bucket.low, bucket.high] as [number, number] };
    const previous = buckets[index - 1];
    const next = buckets[index + 1];
    const joinsPrevious = previous !== undefined && bucket.t - previous.t <= BUCKET_MS;
    const joinsNext = next !== undefined && next.t - bucket.t <= BUCKET_MS;
    const points: CpuPoint[] =
      joinsPrevious || joinsNext
        ? [{ ...values, t: bucket.t + BUCKET_MS / 2 }]
        : [
            { ...values, t: bucket.t },
            { ...values, t: bucket.t + BUCKET_MS },
          ];
    return joinsNext ? points : [...points, { average: null, band: null, t: bucket.t + BUCKET_MS }];
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
  up: 'Up',
};

export const statusWord = (status: LaneStatus): string => STATUS_WORDS[status];

// The line under a lane's status: its newest CPU and memory, or since when it
// has been asleep or silent, so old Vitals never read as current.
export const nowLine = (
  lane: Lane,
  { now, timeZone }: { now: number; timeZone: string },
): string => {
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
  return lane.latest === undefined
    ? 'no Vitals'
    : `CPU ${String(Math.round(lane.latest.cpuBusyPercent))}%, memory ${String(Math.round(lane.latest.memoryUsedPercent))}%`;
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
