import type { ConditionLevel } from '@heimdall/schema';
import type { SQL } from 'bun';

import type { ClockLimits } from './condition-limits.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import type { SystemConditionThresholds } from './system-conditions.ts';
import { whenPaired } from './tokens.ts';

// An offset the Hub judged longer ago than this is not evidence of the clock now.
const FRESH_OFFSET_MS = 10 * 60_000;

// Systems whose clock offsets lie this close together share one error, the
// Hub's own.
const AGREEMENT_MS = 5000;

const LEVELS = ['note', 'warning', 'alert'] as const;

// One System's latest clock offset (its clock less the Hub's, in milliseconds)
// and the offset at which its own limits make it a note.
type Offset = { noteMs: number; offsetMs: number; system: string };

// Who is wrong when the Hub's own clock is.
export type HubBlame = {
  // The Systems whose clocks disagree with the Hub's alike, sorted.
  agreeing: string[];
  // The one System that reads true; its Collector shares the Hub's clock.
  blamed: string;
  // How far the Hub's clock is ahead of the others' (negative: behind).
  hubOffsetMs: number;
};

const median = (sorted: readonly number[]) => {
  const middle = Math.floor(sorted.length / 2);
  const [below, above] = [sorted[middle - 1] ?? 0, sorted[middle] ?? 0];
  return sorted.length % 2 === 1 ? above : Math.round((below + above) / 2);
};

// The Hub's clock is wrong, not the Systems', when at least two Systems are
// past their note limits, all within 5 seconds of one another, and exactly one
// System is under its own: a Hub whose clock is off puts every other System
// off alike, while its own Collector reads true. Otherwise nobody is blamed.
export const blameHubClock = (offsets: readonly Offset[]): HubBlame | undefined => {
  const skewed = offsets.filter(({ noteMs, offsetMs }) => Math.abs(offsetMs) >= noteMs);
  const reading = offsets.filter(({ noteMs, offsetMs }) => Math.abs(offsetMs) < noteMs);
  const [blamed] = reading;
  if (skewed.length < 2 || reading.length !== 1 || blamed === undefined) {
    return undefined;
  }
  const sorted = skewed.map(({ offsetMs }) => offsetMs).toSorted((a, b) => a - b);
  if ((sorted.at(-1) ?? 0) - (sorted[0] ?? 0) > AGREEMENT_MS) {
    return undefined;
  }
  return {
    agreeing: skewed.map(({ system }) => system).toSorted(),
    blamed: blamed.system,
    hubOffsetMs: -median(sorted),
  };
};

// `42 s`, `3 min 2 s`, or `1 h 2 min`: the span to the nearest second.
const spanText = (ms: number) => {
  const total = Math.round(ms / 1000);
  const parts = [
    [Math.floor(total / 3600), 'h'],
    [Math.floor((total % 3600) / 60), 'min'],
    [total % 60, 's'],
  ].filter(([count]) => count !== 0);
  return parts.length === 0
    ? '0 s'
    : parts.map(([count, unit]) => `${String(count)} ${unit}`).join(' ');
};

const direction = (offsetMs: number) => (offsetMs > 0 ? 'ahead of' : 'behind');

// Escalation is immediate. A level that is current, or lower than the current
// one, holds until the skew is a hysteresis below its limit; a drop can skip
// levels or clear outright (undefined). Limits are in seconds.
const clockLevel = (
  skewMs: number,
  limits: ClockLimits,
  current: ConditionLevel | undefined,
): ConditionLevel | undefined => {
  const skew = skewMs / 1000;
  const currentRank = current === undefined ? -1 : LEVELS.indexOf(current);
  return LEVELS.toReversed().find(
    (level) =>
      skew >= limits[level] ||
      (LEVELS.indexOf(level) <= currentRank && skew >= limits[level] - limits.hysteresis),
  );
};

// What one System's Condition is judged on: the skew to level, and why.
type Judgment = { reason: string; skewMs: number } | 'clear' | 'hold';

const judgmentOf = ({
  blame,
  offsets,
  system,
}: {
  blame: HubBlame | undefined;
  offsets: ReadonlyMap<string, number>;
  system: string;
}): Judgment => {
  if (blame?.agreeing.includes(system) === true) {
    return 'clear';
  }
  if (blame?.blamed === system) {
    return {
      reason: `The Hub's clock is ${spanText(Math.abs(blame.hubOffsetMs))} ${direction(blame.hubOffsetMs)} ${String(blame.agreeing.length)} other Systems.`,
      skewMs: Math.abs(blame.hubOffsetMs),
    };
  }
  const offset = offsets.get(system);
  return offset === undefined
    ? 'hold'
    : {
        reason: `Its clock is ${spanText(Math.abs(offset))} ${direction(offset)} the Hub's.`,
        skewMs: Math.abs(offset),
      };
};

// Raises, re-levels, or clears one System's clock skew Condition under the
// System's row lock, so it orders with the System's Reports (ADR-0005). A
// System that is no longer paired has it cleared.
const evaluateSystem = (
  sql: SQL,
  system: string,
  {
    blame,
    clock,
    offsets,
    thresholds,
  }: {
    blame: HubBlame | undefined;
    clock: () => number;
    offsets: ReadonlyMap<string, number>;
    thresholds: SystemConditionThresholds;
  },
) =>
  sql.begin(async (tx) => {
    await tx`SELECT 1 FROM systems WHERE name = ${system} FOR UPDATE`;
    const now = new Date(clock());
    const judgment =
      (await whenPaired(tx, system)) === undefined
        ? 'clear'
        : judgmentOf({ blame, offsets, system });
    if (judgment === 'hold') {
      return;
    }
    const [held]: { level: ConditionLevel }[] = await tx`
      SELECT level FROM conditions
      WHERE system = ${system} AND kind = 'clock_skew' AND subject = '' AND cleared_at IS NULL
    `;
    const limits = thresholds.systems.get(system)?.clock ?? thresholds.clock;
    const level =
      judgment === 'clear' ? undefined : clockLevel(judgment.skewMs, limits, held?.level);
    if (judgment === 'clear' || level === undefined) {
      await clear(tx, { kind: 'clock_skew', now, subject: '', system });
    } else {
      await raise(tx, {
        kind: 'clock_skew',
        level,
        now,
        reason: judgment.reason,
        subject: '',
        system,
      });
    }
  });

// Judges every paired System's clock skew Condition from the offset its latest
// Report left, when the Hub judged that offset within the last 10 minutes at
// `clock` (epoch milliseconds), and clears those of a System that is no longer
// paired. A System with no fresh offset keeps its Condition as it is. When the
// Hub's own clock is the likelier culprit, only the System sharing it is
// blamed. `serve` runs it every minute. A System that cannot be judged does
// not stop the rest; one error then names each such System and why.
export const evaluateClockConditions = async (
  sql: SQL,
  clock: () => number,
  thresholds: SystemConditionThresholds,
): Promise<void> => {
  const fresh: { offset_ms: string | number; system: string }[] = await sql`
    SELECT s.name AS system, s.clock_offset_ms AS offset_ms
    FROM systems s JOIN paired_systems p ON p.system = s.name
    WHERE s.clock_offset_at >= ${new Date(clock() - FRESH_OFFSET_MS)}
  `;
  const offsets = new Map(fresh.map(({ offset_ms, system }) => [system, Number(offset_ms)]));
  const blame = blameHubClock(
    [...offsets].map(([system, offsetMs]) => ({
      noteMs: 1000 * (thresholds.systems.get(system)?.clock ?? thresholds.clock).note,
      offsetMs,
      system,
    })),
  );
  const withConditions: { system: string }[] = await sql`
    SELECT system FROM conditions WHERE kind = 'clock_skew' AND cleared_at IS NULL
  `;
  const systems = new Set([...offsets.keys(), ...withConditions.map((row) => row.system)]);
  await evaluateEach([...systems].toSorted(), (system) =>
    evaluateSystem(sql, system, { blame, clock, offsets, thresholds }),
  );
};
