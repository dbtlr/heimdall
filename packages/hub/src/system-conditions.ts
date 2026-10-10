import { VitalsSampleSchema } from '@heimdall/schema';
import type { VitalsSample } from '@heimdall/schema';
import type { SQL } from 'bun';

import { clear, evaluateEach, raise } from './conditions.ts';

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

// Stale System: the System was not heard from for longer than its limit.
// `since` is when the Hub last heard from it, or when it was paired if that is
// later, in which case it has not been heard from since.
const staleVerdict = ({
  limitMs,
  now,
  pairedAt,
  since,
}: {
  limitMs: number;
  now: number;
  pairedAt: number;
  since: number;
}): Verdict => {
  if (now - since <= limitMs) {
    return 'clear';
  }
  const from = since === pairedAt ? `it was paired at ${utcMinute(since)}` : utcMinute(since);
  return { raise: `Not heard from since ${from}, more than ${spanText(limitMs)} ago.` };
};

// Low disk: a mount is low below `lowDiskBelow` free and recovers above
// `lowDiskClearAbove`, so one that hovers near the limit does not flap.
// A mount with no size has no free fraction and is left as it is.
const diskVerdict = (
  { totalBytes, usedBytes }: Disk,
  { lowDiskBelow, lowDiskClearAbove }: SystemConditionThresholds,
): Verdict => {
  if (totalBytes === 0) {
    return 'hold';
  }
  // The schema allows a mount used past its size.
  const freeBytes = Math.max(totalBytes - usedBytes, 0);
  const free = freeBytes / totalBytes;
  if (free < lowDiskBelow) {
    return {
      raise: `${bytesText(freeBytes)} free of ${bytesText(totalBytes)} (${(free * 100).toFixed(1)}%).`,
    };
  }
  return free > lowDiskClearAbove ? 'clear' : 'hold';
};

const DISKS_SCHEMA = VitalsSampleSchema.shape.disks;

// The mounts in the System's latest Vitals sample, or undefined when it has
// none the Hub can read.
const latestDisks = async (tx: SQL, system: string): Promise<Disk[] | undefined> => {
  const [row]: { disks: unknown }[] = await tx`
    SELECT disks FROM vitals_samples WHERE system = ${system} ORDER BY t DESC LIMIT 1
  `;
  return DISKS_SCHEMA.safeParse(row?.disks).data;
};

type Held = { last_seen_at: Date; sleeps: boolean | null };

// Locks the System's row and answers what it holds. A paired System the Hub
// has never heard from has no row, and gets one, seen at its pairing, only
// once it has been silent past `limitMs`, since the Conditions need a row.
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
  await tx`
    INSERT INTO systems (name, last_seen_at) VALUES (${system}, ${new Date(pairedAt)})
    ON CONFLICT (name) DO NOTHING
  `;
  return lock();
};

// Raises and clears one System's stale System and low disk Conditions under
// the System's row lock, so they order with its Reports (ADR-0005), at the
// time `clock` reads once the lock is held.
const evaluateSystem = (
  sql: SQL,
  system: string,
  clock: () => number,
  thresholds: SystemConditionThresholds,
) =>
  sql.begin(async (tx) => {
    const [paired]: { paired_at: Date }[] = await tx`
      SELECT paired_at FROM paired_systems WHERE system = ${system}
    `;
    if (paired === undefined) {
      return;
    }
    const pairedAt = paired.paired_at.getTime();
    // Without the lock the clock is read early, only to decide whether a row is due.
    const held = await lockSystem(tx, {
      limitMs: thresholds.staleAfterMs,
      now: clock(),
      pairedAt,
      system,
    });
    if (held === undefined) {
      return;
    }
    const now = clock();
    const at = new Date(now);
    const lastSeenAt = held.last_seen_at.getTime();
    const apply = async (kind: 'low_disk' | 'system_stale', subject: string, verdict: Verdict) => {
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
        limitMs: held.sleeps === true ? thresholds.sleepingStaleAfterMs : thresholds.staleAfterMs,
        now,
        pairedAt,
        since: Math.max(lastSeenAt, pairedAt),
      }),
    );

    const disks = await latestDisks(tx, system);
    if (disks === undefined) {
      return;
    }
    const open: { subject: string }[] = await tx`
      SELECT subject FROM conditions
      WHERE system = ${system} AND kind = 'low_disk' AND cleared_at IS NULL
    `;
    const mounts = new Map(disks.map((disk) => [disk.mount, disk]));
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
// it holds that System's lock. `serve` runs it every minute. A System that
// cannot be judged does not stop the rest; one error then names each such
// System and why.
export const evaluateSystemConditions = async (
  sql: SQL,
  clock: () => number,
  thresholds: SystemConditionThresholds,
): Promise<void> => {
  const systems: { system: string }[] =
    await sql`SELECT system FROM paired_systems ORDER BY system`;
  await evaluateEach(
    systems.map((row) => row.system),
    (system) => evaluateSystem(sql, system, clock, thresholds),
  );
};
