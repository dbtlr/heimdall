import { VitalsSampleSchema } from '@heimdall/schema';
import type { VitalsSample } from '@heimdall/schema';
import type { SQL } from 'bun';

import { clear, evaluateEach, raise } from './conditions.ts';
import type { ConditionKind } from './store.ts';
import { pairedSystems, whenPaired } from './tokens.ts';

// What decides the Conditions about a System as a whole. The evaluator takes
// them as a parameter, so Hub configuration can supply them later.
export type SystemConditionThresholds = {
  // A mount's free space, as a fraction of its size, above which low disk
  // clears. Between this and `lowDiskBelow` an open Condition is held.
  lowDiskClearAbove: number;
  // A mount's free space, as a fraction of its size, below which low disk is raised.
  lowDiskBelow: number;
  // How long a System that sleeps may go unheard from before it is stale.
  sleepingStaleAfterMs: number;
  // How long an always-on System may go unheard from before it is stale.
  staleAfterMs: number;
};

export const SYSTEM_CONDITION_THRESHOLDS: SystemConditionThresholds = {
  lowDiskBelow: 0.1,
  lowDiskClearAbove: 0.15,
  sleepingStaleAfterMs: 7 * 24 * 60 * 60_000,
  staleAfterMs: 10 * 60_000,
};

// What the Hub should do with one Condition: raise it with a reason (or update
// the reason of the open one), clear it, or leave it as it is.
type Verdict = { raise: string } | 'clear' | 'hold';

type Disk = VitalsSample['disks'][number];

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

// `bytes` in the largest binary unit that keeps it at 1 or more, such as `9.9 GiB`.
const bytesText = (bytes: number) => {
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${UNITS[unit]}`;
};

// `2026-10-06 12:00 UTC`.
const utcMinute = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const DAY_MS = 24 * 60 * 60_000;

// A span such as `10 minutes` or `7 days`.
const spanText = (ms: number) => {
  const [count, unit] =
    ms % DAY_MS === 0 ? [ms / DAY_MS, 'day'] : [Math.round(ms / 60_000), 'minute'];
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
};

// Stale System: the System was not heard from for longer than its limit,
// counted from when the Hub last heard from it, or, if it never has, from when
// it was paired.
const staleVerdict = ({
  lastSeenAt,
  limitMs,
  now,
  pairedAt,
}: {
  lastSeenAt: number | undefined;
  limitMs: number;
  now: number;
  pairedAt: number;
}): Verdict => {
  const since = lastSeenAt ?? pairedAt;
  if (now - since <= limitMs) {
    return 'clear';
  }
  const from = lastSeenAt === undefined ? `it was paired at ${utcMinute(since)}` : utcMinute(since);
  return { raise: `Not heard from since ${from}, more than ${spanText(limitMs)} ago.` };
};

// How much of a mount is free, as bytes and as a fraction of its size, or
// undefined for a mount with no size. The schema allows a mount used past its
// size, which has nothing free.
const freeOf = ({ totalBytes, usedBytes }: Disk) => {
  const bytes = Math.max(totalBytes - usedBytes, 0);
  return totalBytes === 0 ? undefined : { bytes, fraction: bytes / totalBytes };
};

// Of two entries for one mount, the one with less free space, so that the
// order of the entries does not decide the verdict. An entry with no size
// loses to one with a size.
const tighter = (a: Disk, b: Disk) => {
  const [freeA, freeB] = [freeOf(a), freeOf(b)];
  if (freeA === undefined || freeB === undefined) {
    return freeA === undefined ? b : a;
  }
  return freeB.fraction < freeA.fraction ||
    (freeB.fraction === freeA.fraction && freeB.bytes < freeA.bytes)
    ? b
    : a;
};

// Low disk: a mount is low below `lowDiskBelow` free and recovers above
// `lowDiskClearAbove`, so one that hovers near the limit does not flap.
// A mount with no size has no free fraction and is left as it is.
const diskVerdict = (
  disk: Disk,
  { lowDiskBelow, lowDiskClearAbove }: SystemConditionThresholds,
): Verdict => {
  const free = freeOf(disk);
  if (free === undefined) {
    return 'hold';
  }
  if (free.fraction < lowDiskBelow) {
    return {
      raise: `${bytesText(free.bytes)} free of ${bytesText(disk.totalBytes)} (${(free.fraction * 100).toFixed(1)}%).`,
    };
  }
  return free.fraction > lowDiskClearAbove ? 'clear' : 'hold';
};

const DISKS_SCHEMA = VitalsSampleSchema.shape.disks;

// How far ahead of the Hub's clock a sample's time may be and still count as
// the System's latest: a System with a wrong clock stamps its samples far in
// the future, and the newest of those would otherwise stay the latest sample
// for as long as the clock is wrong.
export const FUTURE_SAMPLE_TOLERANCE_MS = 5 * 60_000;

// The mounts in the System's latest Vitals sample stamped no later than
// `now` plus the tolerance, or undefined when it has none the Hub can read.
// The Hub does not store when it received a sample.
const latestDisks = async (tx: SQL, system: string, now: number): Promise<Disk[] | undefined> => {
  const [row]: { disks: unknown }[] = await tx`
    SELECT disks FROM vitals_samples
    WHERE system = ${system} AND t <= ${new Date(now + FUTURE_SAMPLE_TOLERANCE_MS)}
    ORDER BY t DESC LIMIT 1
  `;
  return DISKS_SCHEMA.safeParse(row?.disks).data;
};

type Held = { last_seen_at: Date | null; sleeps: boolean | null };

// Locks the System's row and answers what it holds. A paired System the Hub
// has never heard from has no row, and gets one with no last seen only once it
// has been silent past `limitMs`, since the Conditions need a row.
const lockSystem = async (
  tx: SQL,
  {
    limitMs,
    now,
    pairedAt,
    system,
  }: { limitMs: number; now: number; pairedAt: number; system: string },
): Promise<Held | undefined> => {
  const lock = async () => {
    const [held]: Held[] = await tx`
      SELECT last_seen_at, sleeps FROM systems WHERE name = ${system} FOR UPDATE
    `;
    return held;
  };
  const held = await lock();
  if (held !== undefined || now - pairedAt <= limitMs) {
    return held;
  }
  await tx`INSERT INTO systems (name) VALUES (${system}) ON CONFLICT (name) DO NOTHING`;
  return lock();
};

const SYSTEM_KINDS = ['system_stale', 'low_disk'] as const satisfies readonly ConditionKind[];

// Clears every stale System and low disk Condition a System holds, for one that
// is no longer paired and so is no longer judged.
const withdraw = async (tx: SQL, { now, system }: { now: Date; system: string }) => {
  await tx`SELECT 1 FROM systems WHERE name = ${system} FOR UPDATE`;
  await tx`
    UPDATE conditions SET cleared_at = GREATEST(raised_at, ${now})
    WHERE system = ${system} AND kind IN ${tx([...SYSTEM_KINDS])} AND cleared_at IS NULL
  `;
};

// Raises and clears one System's stale System and low disk Conditions under
// the System's row lock, so they order with its Reports (ADR-0005), at the
// time `clock` reads once the lock is held. A System that is not paired, such
// as one unpaired since it was listed, has its Conditions cleared instead.
// Exported for tests of that path.
export const evaluateSystem = (
  sql: SQL,
  system: string,
  clock: () => number,
  thresholds: SystemConditionThresholds,
) =>
  sql.begin(async (tx) => {
    const pairedAtMs = await whenPaired(tx, system);
    if (pairedAtMs === undefined) {
      await withdraw(tx, { now: new Date(clock()), system });
      return;
    }
    // Without the lock the clock is read early, only to decide whether a row is due.
    const held = await lockSystem(tx, {
      limitMs: thresholds.staleAfterMs,
      now: clock(),
      pairedAt: pairedAtMs,
      system,
    });
    if (held === undefined) {
      return;
    }
    const now = clock();
    const at = new Date(now);
    const apply = async (
      kind: (typeof SYSTEM_KINDS)[number],
      subject: string,
      verdict: Verdict,
    ) => {
      if (verdict === 'clear') {
        await clear(tx, { kind, now: at, subject, system });
      } else if (verdict !== 'hold') {
        await raise(tx, { kind, now: at, reason: verdict.raise, subject, system });
      }
    };

    await apply(
      'system_stale',
      '',
      staleVerdict({
        lastSeenAt: held.last_seen_at?.getTime(),
        limitMs: held.sleeps === true ? thresholds.sleepingStaleAfterMs : thresholds.staleAfterMs,
        now,
        pairedAt: pairedAtMs,
      }),
    );

    const disks = await latestDisks(tx, system, now);
    if (disks === undefined) {
      return;
    }
    const open: { subject: string }[] = await tx`
      SELECT subject FROM conditions
      WHERE system = ${system} AND kind = 'low_disk' AND cleared_at IS NULL
    `;
    const mounts = new Map<string, Disk>();
    for (const disk of disks) {
      const other = mounts.get(disk.mount);
      mounts.set(disk.mount, other === undefined ? disk : tighter(other, disk));
    }
    const subjects = new Set([...mounts.keys(), ...open.map((condition) => condition.subject)]);
    for (const subject of subjects) {
      const disk = mounts.get(subject);
      // A mount that left the samples recovered or was unmounted.
      // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
      await apply(
        'low_disk',
        subject,
        disk === undefined ? 'clear' : diskVerdict(disk, thresholds),
      );
    }
  });

// Raises and clears every paired System's stale System and low disk
// Conditions, judging each at the time `clock` (epoch milliseconds) reads once
// it holds that System's lock, and clears those of a System that is no longer
// paired. `serve` runs it every minute. A System that cannot be judged does
// not stop the rest; one error then names each such System and why.
export const evaluateSystemConditions = async (
  sql: SQL,
  clock: () => number,
  thresholds: SystemConditionThresholds,
): Promise<void> => {
  const withConditions: { system: string }[] = await sql`
    SELECT system FROM conditions
    WHERE kind IN ${sql([...SYSTEM_KINDS])} AND cleared_at IS NULL
  `;
  const systems = new Set([...(await pairedSystems(sql)), ...withConditions.map((r) => r.system)]);
  await evaluateEach([...systems].toSorted(), (system) =>
    evaluateSystem(sql, system, clock, thresholds),
  );
};
