import { CLOCK_OFFSET_FRESH_MS, CLOCK_SKEW_SUBJECTS } from '@heimdall/schema';
import type { ConditionLevel } from '@heimdall/schema';
import type { SQL } from 'bun';

import { gradedLevel } from './condition-limits.ts';
import type { Bands } from './condition-limits.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import type { SystemConditionThresholds } from './system-conditions.ts';
import { whenPaired } from './tokens.ts';

// A System within this of the Hub's clock reads true; off Systems whose
// offsets lie this close together share one error, the Hub's own.
const AGREEMENT_MS = 5000;

// One System's latest clock offset: its clock less the Hub's, in milliseconds.
type Offset = { offsetMs: number; system: string };

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

// The Hub's clock is wrong, not the Systems', when exactly one System reads
// true (within 5 seconds of the Hub) and at least two are off, all within 5
// seconds of one another: a Hub whose clock is off puts every other System off
// alike, while its own Collector reads true. Otherwise nobody is blamed. The
// distance from the Hub, not a note limit, classifies the Systems, so the rule
// does not flap while the Hub drifts through a limit, when every other System
// sits at the limit with millisecond jitter, and a System recovering inside
// its hysteresis band does not count as true. Note limits grade the Hub's
// offset afterward, so a small one raises nothing.
export const blameHubClock = (offsets: readonly Offset[]): HubBlame | undefined => {
  const off = offsets.filter(({ offsetMs }) => Math.abs(offsetMs) > AGREEMENT_MS);
  const reading = offsets.filter(({ offsetMs }) => Math.abs(offsetMs) <= AGREEMENT_MS);
  const [blamed] = reading;
  if (off.length < 2 || reading.length !== 1 || blamed === undefined) {
    return undefined;
  }
  const sorted = off.map(({ offsetMs }) => offsetMs).toSorted((a, b) => a - b);
  if ((sorted.at(-1) ?? 0) - (sorted[0] ?? 0) > AGREEMENT_MS) {
    return undefined;
  }
  return {
    agreeing: off.map(({ system }) => system).toSorted(),
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

// What one clock skew identity of a System is judged on: the skew to level,
// and why.
type Judgment = { reason: string; skewMs: number } | 'clear' | 'hold';

type Judgments = Record<keyof typeof CLOCK_SKEW_SUBJECTS, Judgment>;

// A System's clock skew identities: its own clock against the Hub's, and the
// Hub's clock, which only the System sharing it is blamed for. The Hub's clock
// is blamed on one System, and its own clock is left unjudged there; on every
// other System the blame leaves only its own clock to judge.
const judgmentsOf = ({
  blame,
  offsets,
  system,
}: {
  blame: HubBlame | undefined;
  offsets: ReadonlyMap<string, number>;
  system: string;
}): Judgments => {
  if (blame?.agreeing.includes(system) === true) {
    return { hub: 'clear', own: 'clear' };
  }
  if (blame?.blamed === system) {
    return {
      hub: {
        reason: `The Hub's clock is ${spanText(Math.abs(blame.hubOffsetMs))} ${direction(blame.hubOffsetMs)} ${String(blame.agreeing.length)} other Systems.`,
        skewMs: Math.abs(blame.hubOffsetMs),
      },
      own: 'clear',
    };
  }
  const offset = offsets.get(system);
  return offset === undefined
    ? { hub: 'hold', own: 'hold' }
    : {
        hub: 'clear',
        own: {
          reason: `Its clock is ${spanText(Math.abs(offset))} ${direction(offset)} the Hub's.`,
          skewMs: Math.abs(offset),
        },
      };
};

// Raises, re-levels, or clears the System's clock skew Condition of one
// identity, levelling by that identity's own held level.
const applyJudgment = async (
  tx: SQL,
  {
    judgment,
    limits,
    now,
    subject,
    system,
  }: {
    judgment: Judgment;
    limits: Bands;
    now: Date;
    subject: string;
    system: string;
  },
) => {
  if (judgment === 'hold') {
    return;
  }
  const [held]: { level: ConditionLevel }[] = await tx`
    SELECT level FROM conditions
    WHERE system = ${system} AND kind = 'clock_skew' AND subject = ${subject} AND cleared_at IS NULL
  `;
  const level =
    judgment === 'clear' ? undefined : gradedLevel(judgment.skewMs / 1000, limits, held?.level);
  if (judgment === 'clear' || level === undefined) {
    await clear(tx, { kind: 'clock_skew', now, subject, system });
  } else {
    await raise(tx, { kind: 'clock_skew', level, now, reason: judgment.reason, subject, system });
  }
};

// Raises, re-levels, or clears one System's clock skew Conditions under the
// System's row lock, so they order with the System's Reports (ADR-0005). A
// System that is no longer paired has them cleared.
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
    const judgments: Judgments =
      (await whenPaired(tx, system)) === undefined
        ? { hub: 'clear', own: 'clear' }
        : judgmentsOf({ blame, offsets, system });
    const limits = thresholds.systems.get(system)?.clock ?? thresholds.clock;
    for (const identity of ['own', 'hub'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
      await applyJudgment(tx, {
        judgment: judgments[identity],
        limits,
        now,
        subject: CLOCK_SKEW_SUBJECTS[identity],
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
    WHERE s.clock_offset_at >= ${new Date(clock() - CLOCK_OFFSET_FRESH_MS)}
  `;
  const offsets = new Map(fresh.map(({ offset_ms, system }) => [system, Number(offset_ms)]));
  const blame = blameHubClock([...offsets].map(([system, offsetMs]) => ({ offsetMs, system })));
  const withConditions: { system: string }[] = await sql`
    SELECT system FROM conditions WHERE kind = 'clock_skew' AND cleared_at IS NULL
  `;
  const systems = new Set([...offsets.keys(), ...withConditions.map((row) => row.system)]);
  await evaluateEach([...systems].toSorted(), (system) =>
    evaluateSystem(sql, system, { blame, clock, offsets, thresholds }),
  );
};
