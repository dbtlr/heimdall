import {
  PendingUpdateSchema,
  UpdateManagerSchema,
  RebootObservationSchema,
  freshUpdateTime,
  UPDATE_MANAGER_NAMES,
  UPDATE_METADATA_MAX_AGE_MS,
  updateSourceSubject,
} from '@heimdall/schema';
import type { ConditionLevel, UpdateManager } from '@heimdall/schema';
import type { SQL } from 'bun';

import type { ConditionLimits } from './condition-limits.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import { pairedSystems, whenPaired } from './tokens.ts';
import { clearEmptySource, updateRecovered } from './update-observations.ts';

const KINDS = ['pending_update', 'reboot_required'] as const;
const DAY = 86400000;
type Subject = {
  subject: string;
  manager: UpdateManager['manager'];
  installation: string;
  name: string;
  first_seen_at: Date;
  security_since: Date | null;
  observed_at: Date;
  pending_update: unknown;
};

// What the Hub has judged so far about one package source's pending packages.
type SourceState = {
  // Whether fresh evidence knows the security of every package.
  canLower: boolean;
  manager: UpdateManager['manager'];
  packages: number;
  // How many of the packages are security updates.
  security: number;
  // Whether a security update has waited longer than the System's limit.
  warning: boolean;
};

const sourceReason = ({ manager, packages, security }: SourceState) => {
  const outOfDate = `${String(packages)} ${UPDATE_MANAGER_NAMES[manager]} ${packages === 1 ? 'package is' : 'packages are'} out of date`;
  if (security === 0) {
    return `${outOfDate}.`;
  }
  return `${outOfDate}, ${security === 1 ? '1 of them is a security update' : `${String(security)} of them are security updates`}.`;
};

// The pending packages, manager observations, reboot marker, and held levels
// read under one System's lock, with its effective update limits.
export type UpdateConditionFacts = {
  subjects: readonly Subject[];
  managers: readonly { manager: string; installation: string; observation: unknown }[];
  open: readonly { kind: (typeof KINDS)[number]; subject: string; level: ConditionLevel }[];
  reboot: { observation: unknown; first_required_at: Date | null } | undefined;
  limits: ConditionLimits['updates'];
};

type UpdateVerdict = 'clear' | 'hold' | { level: ConditionLevel; raise: string };

// One Condition per package source counts its remaining packages. Observation
// time belongs to the Collector. Age thresholds start only when the Hub
// confirms positive evidence, so backlogs cannot invent pending age.
// Unknown security and lost coverage cannot lower a held warning. Only fresh
// recovery clears packages or reboot markers and starts a later age anew.
export const judgeUpdateConditions = (
  facts: UpdateConditionFacts,
  now: number,
): {
  recoveredSubjects: string[];
  pending: Map<string, { level: ConditionLevel; raise: string }>;
  emptySources: string[];
  reboot: UpdateVerdict;
} => {
  const recoveredSubjects: string[] = [];
  const pending = new Map<string, { level: ConditionLevel; raise: string }>();
  const emptySources: string[] = [];
  // One Condition per package source; its packages are the evidence.
  const sources = new Map<string, SourceState>();
  for (const subject of facts.subjects) {
    const update = PendingUpdateSchema.parse(subject.pending_update);
    const observation = facts.managers.find(
      (manager) =>
        manager.manager === subject.manager && manager.installation === subject.installation,
    )?.observation;
    const parsed = UpdateManagerSchema.safeParse(observation);
    let recovered = false;
    let canLower = false;
    if (parsed.success) {
      const manager = parsed.data;
      const fresh =
        freshUpdateTime(manager.observedAt, now) &&
        manager.observedAt >= subject.observed_at.getTime() &&
        manager.result.kind === 'available' &&
        manager.result.metadataAt !== null &&
        freshUpdateTime(manager.result.metadataAt, now, UPDATE_METADATA_MAX_AGE_MS);
      recovered = updateRecovered({
        available: update.available,
        manager,
        name: subject.name,
        now,
        observedAt: subject.observed_at.getTime(),
      });
      canLower =
        fresh &&
        manager.result.kind === 'available' &&
        manager.result.updates.some((item) => item.name === subject.name && item.security !== null);
    }
    if (recovered) {
      recoveredSubjects.push(subject.subject);
      continue;
    }
    const key = updateSourceSubject(subject);
    const state = sources.get(key) ?? {
      canLower: true,
      manager: subject.manager,
      packages: 0,
      security: 0,
      warning: false,
    };
    state.canLower &&= canLower;
    state.packages += 1;
    if (subject.security_since !== null) {
      state.security += 1;
      state.warning ||=
        now - subject.security_since.getTime() > facts.limits.securityWarningDays * DAY;
    }
    sources.set(key, state);
  }
  for (const [subject, state] of sources) {
    const held = facts.open.find(
      (item) => item.kind === 'pending_update' && item.subject === subject,
    );
    // Unknown security or lost coverage must not lower an already open warning.
    const level =
      state.warning || (!state.canLower && held?.level === 'warning') ? 'warning' : 'note';
    pending.set(subject, { level, raise: sourceReason(state) });
  }
  for (const held of facts.open) {
    if (held.kind === 'pending_update' && !sources.has(held.subject)) {
      emptySources.push(held.subject);
    }
  }
  const reboot = facts.reboot;
  if (reboot === undefined) {
    return { emptySources, pending, reboot: 'hold', recoveredSubjects };
  }
  const observation = RebootObservationSchema.parse(reboot.observation);
  if (
    observation.kind === 'available' &&
    !observation.required &&
    freshUpdateTime(observation.observedAt, now)
  ) {
    return { emptySources, pending, reboot: 'clear', recoveredSubjects };
  } else if (reboot.first_required_at !== null) {
    const held = facts.open.find((item) => item.kind === 'reboot_required');
    const warning = now - reboot.first_required_at.getTime() > facts.limits.rebootWarningDays * DAY;
    return {
      emptySources,
      pending,
      reboot: {
        level:
          warning ||
          (!(observation.kind === 'available' && freshUpdateTime(observation.observedAt, now)) &&
            held?.level === 'warning')
            ? 'warning'
            : 'note',
        raise: 'A reboot is required; confirmed by the local reboot-required marker.',
      },
      recoveredSubjects,
    };
  }
  return { emptySources, pending, reboot: 'hold', recoveredSubjects };
};

// Reads and applies update judgments under the System lock, ordering with
// Reports. An unpaired System withdraws its evidence and Conditions instead.
export const evaluateUpdateSystem = (
  sql: SQL,
  system: string,
  clock: () => number,
  limits: ConditionLimits,
) =>
  sql.begin(async (tx) => {
    const pairedAt = await whenPaired(tx, system);
    await tx`SELECT 1 FROM systems WHERE name = ${system} FOR UPDATE`;
    const now = clock();
    const at = new Date(now);
    const open: { kind: (typeof KINDS)[number]; subject: string; level: ConditionLevel }[] =
      await tx`
    SELECT kind, subject, level FROM conditions WHERE system = ${system}
      AND kind IN ${tx([...KINDS])} AND cleared_at IS NULL
  `;
    if (pairedAt === undefined) {
      for (const held of open) {
        // oxlint-disable-next-line no-await-in-loop -- clearing shares the System transaction.
        await clear(tx, { ...held, now: at, system });
      }
      await tx`DELETE FROM update_subjects WHERE system = ${system}`;
      await tx`UPDATE update_managers SET withdrawn = true WHERE system = ${system}`;
      await tx`UPDATE reboot_observations SET first_required_at = NULL, withdrawn = true WHERE system = ${system}`;
      return;
    }
    const effective = limits.systems.get(system)?.updates ?? limits.updates;
    const managers: { manager: string; installation: string; observation: unknown }[] = await tx`
    SELECT manager, installation, observation FROM update_managers WHERE system = ${system}
  `;
    const subjects: Subject[] = await tx`SELECT * FROM update_subjects WHERE system = ${system}`;
    const [reboot]: { observation: unknown; first_required_at: Date | null }[] = await tx`
      SELECT observation, first_required_at FROM reboot_observations WHERE system = ${system}
    `;
    const judged = judgeUpdateConditions(
      { limits: effective, managers, open, reboot, subjects },
      now,
    );
    for (const subject of judged.recoveredSubjects) {
      // oxlint-disable-next-line no-await-in-loop -- a later recurrence starts its own age.
      await tx`DELETE FROM update_subjects WHERE system = ${system} AND subject = ${subject}`;
    }
    for (const [subject, verdict] of judged.pending) {
      // oxlint-disable-next-line no-await-in-loop -- each judgment shares the System lock.
      await raise(tx, {
        kind: 'pending_update',
        level: verdict.level,
        now: at,
        reason: verdict.raise,
        subject,
        system,
      });
    }
    for (const subject of judged.emptySources) {
      // oxlint-disable-next-line no-await-in-loop -- clearing shares the System transaction.
      await clearEmptySource(tx, { now: at, subject, system });
    }
    if (judged.reboot === 'clear') {
      await clear(tx, { kind: 'reboot_required', now: at, subject: '', system });
      await tx`UPDATE reboot_observations SET first_required_at = NULL WHERE system = ${system}`;
    } else if (judged.reboot !== 'hold') {
      await raise(tx, {
        kind: 'reboot_required',
        level: judged.reboot.level,
        now: at,
        reason: judged.reboot.raise,
        subject: '',
        system,
      });
    }
  });

export const evaluateUpdateConditions = async (
  sql: SQL,
  clock: () => number,
  limits: ConditionLimits,
) => {
  const open: { system: string }[] = await sql`
    SELECT DISTINCT system FROM conditions WHERE kind IN ${sql([...KINDS])} AND cleared_at IS NULL
    UNION SELECT system FROM update_subjects
    UNION SELECT system FROM reboot_observations WHERE first_required_at IS NOT NULL
  `;
  const systems = new Set([...(await pairedSystems(sql)), ...open.map((row) => row.system)]);
  await evaluateEach([...systems].toSorted(), (system) =>
    evaluateUpdateSystem(sql, system, clock, limits),
  );
};
