import { FUTURE_SAMPLE_TOLERANCE_MS, OLD_EVIDENCE_MS, VitalsSampleSchema } from '@heimdall/schema';
import type { ConditionLevel, VitalsSample, ConditionKind } from '@heimdall/schema';
import type { SQL } from 'bun';

import { gradedLevel, parseConditionLimits } from './condition-limits.ts';
import type { ConditionLimits, DiskLimits } from './condition-limits.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import { pairedSystems, whenPaired } from './tokens.ts';

// Stale time limits and measurement limits used by each evaluation pass.
export type SystemConditionThresholds = ConditionLimits & {
  // How long a System that sleeps may go unheard from before it is stale.
  sleepingStaleAfterMs: number;
  // How long an always-on System may go unheard from before it is stale.
  staleAfterMs: number;
};

export const SYSTEM_CONDITION_THRESHOLDS: SystemConditionThresholds = {
  ...parseConditionLimits(undefined),
  sleepingStaleAfterMs: 7 * 24 * 60 * 60_000,
  staleAfterMs: 10 * 60_000,
};

// What the Hub should do with one Condition: raise it with a reason (or update
// the reason of the open one), clear it, or leave it as it is.
type Verdict = { raise: string } | 'clear' | 'hold';
type DiskVerdict = { raise: string; level: ConditionLevel } | 'clear' | 'hold';

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

// Disk use as a graded level, with the mount's free space as the reason.
const diskVerdict = (
  disk: Disk,
  limits: DiskLimits,
  current: ConditionLevel | undefined,
): DiskVerdict => {
  const free = freeOf(disk);
  if (free === undefined) {
    return 'hold';
  }
  const level = gradedLevel((100 * disk.usedBytes) / disk.totalBytes, limits, current);
  return level === undefined
    ? 'clear'
    : {
        level,
        raise: `${bytesText(free.bytes)} free of ${bytesText(disk.totalBytes)} (${(free.fraction * 100).toFixed(1)}%).`,
      };
};

const DISKS_SCHEMA = VitalsSampleSchema.shape.disks;

// The mounts in the System's latest Vitals sample stamped no later than
// `now` plus the tolerance, or undefined when it has none the Hub can read.
// The Hub does not store when it received a sample.
const latestDisks = async (tx: SQL, system: string, now: number) => {
  const [row]: { disks: unknown; t: Date }[] = await tx`
    SELECT disks, t FROM vitals_samples
    WHERE system = ${system} AND t <= ${new Date(now + FUTURE_SAMPLE_TOLERANCE_MS)}
    ORDER BY t DESC LIMIT 1
  `;
  const disks = DISKS_SCHEMA.safeParse(row?.disks).data;
  return row === undefined || disks === undefined
    ? undefined
    : { disks, old: now - row.t.getTime() > OLD_EVIDENCE_MS };
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
  const open: { kind: (typeof SYSTEM_KINDS)[number]; subject: string }[] = await tx`
    SELECT kind, subject FROM conditions
    WHERE system = ${system} AND kind IN ${tx([...SYSTEM_KINDS])} AND cleared_at IS NULL
  `;
  for (const { kind, subject } of open) {
    // oxlint-disable-next-line no-await-in-loop -- each clearing shares this transaction.
    await clear(tx, { kind, now, subject, system });
  }
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
    const apply = async (kind: 'system_stale', subject: string, verdict: Verdict) => {
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

    const latest = await latestDisks(tx, system, now);
    if (latest === undefined) {
      return;
    }
    const open: { subject: string; level: ConditionLevel }[] = await tx`
      SELECT subject, level FROM conditions
      WHERE system = ${system} AND kind = 'low_disk' AND cleared_at IS NULL
    `;
    const mounts = new Map<string, Disk>();
    for (const disk of latest.disks) {
      const other = mounts.get(disk.mount);
      mounts.set(disk.mount, other === undefined ? disk : tighter(other, disk));
    }
    const subjects = new Set([...mounts.keys(), ...open.map((condition) => condition.subject)]);
    const levels = new Map(open.map(({ subject, level }) => [subject, level]));
    const limits = thresholds.systems.get(system)?.disk ?? thresholds.disk;
    for (const subject of subjects) {
      const disk = mounts.get(subject);
      // A mount that left the samples recovered or was unmounted.
      const verdict = disk === undefined ? 'clear' : diskVerdict(disk, limits, levels.get(subject));
      const current = levels.get(subject);
      const order = ['note', 'warning', 'alert'];
      // Old Vitals cannot establish recovery, including a mount missing from
      // that sample. Explicit unpairing still clears under its own rule.
      if (
        latest.old &&
        current !== undefined &&
        (verdict === 'clear' ||
          (verdict !== 'hold' && order.indexOf(verdict.level) < order.indexOf(current)))
      ) {
        continue;
      }
      if (verdict === 'clear') {
        // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
        await clear(tx, { kind: 'low_disk', now: at, subject, system });
      } else if (verdict !== 'hold') {
        // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
        await raise(tx, {
          kind: 'low_disk',
          level: verdict.level,
          now: at,
          reason: verdict.raise,
          subject,
          system,
        });
      }
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
