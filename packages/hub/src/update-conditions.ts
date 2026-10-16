import {
  PendingUpdateSchema,
  UpdateManagerSchema,
  RebootObservationSchema,
  freshUpdateTime,
  UPDATE_METADATA_MAX_AGE_MS,
} from '@heimdall/schema';
import type { ConditionLevel } from '@heimdall/schema';
import type { SQL } from 'bun';

import type { ConditionLimits } from './condition-limits.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import { pairedSystems, whenPaired } from './tokens.ts';
import { updateRecovered } from './update-observations.ts';

const KINDS = ['pending_update', 'reboot_required'] as const;
const DAY = 86400000;
type Subject = {
  subject: string;
  manager: string;
  installation: string;
  name: string;
  first_seen_at: Date;
  security_since: Date | null;
  observed_at: Date;
  pending_update: unknown;
};

// Observation time belongs to the Collector. Age thresholds start only when
// the Hub confirms positive evidence, so backlogs cannot invent pending age.
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
    for (const subject of subjects) {
      const update = PendingUpdateSchema.parse(subject.pending_update);
      const observation = managers.find(
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
          manager.result.updates.some(
            (item) => item.name === subject.name && item.security !== null,
          );
      }
      if (recovered) {
        // oxlint-disable-next-line no-await-in-loop -- recovery and evidence removal commit together.
        await clear(tx, { kind: 'pending_update', now: at, subject: subject.subject, system });
        // oxlint-disable-next-line no-await-in-loop -- a later recurrence starts its own age.
        await tx`DELETE FROM update_subjects WHERE system = ${system} AND subject = ${subject.subject}`;
        continue;
      }
      const warning =
        subject.security_since !== null &&
        now - subject.security_since.getTime() > effective.securityWarningDays * DAY;
      const held = open.find(
        (item) => item.kind === 'pending_update' && item.subject === subject.subject,
      );
      // Unknown security or lost coverage must not lower an already open warning.
      const level = warning || (!canLower && held?.level === 'warning') ? 'warning' : 'note';
      const security = subject.security_since !== null ? 'Security update' : 'Update';
      const reason = `${security} pending for ${subject.name} (${subject.manager}): ${update.installed ?? 'unknown'} → ${update.available ?? 'unknown'}.`;
      // oxlint-disable-next-line no-await-in-loop -- each judgment shares the System lock.
      await raise(tx, {
        kind: 'pending_update',
        level,
        now: at,
        reason,
        subject: subject.subject,
        system,
      });
    }
    const [reboot]: { observation: unknown; first_required_at: Date | null }[] = await tx`
    SELECT observation, first_required_at FROM reboot_observations WHERE system = ${system}
  `;
    if (reboot === undefined) {
      return;
    }
    const observation = RebootObservationSchema.parse(reboot.observation);
    if (
      observation.kind === 'available' &&
      !observation.required &&
      freshUpdateTime(observation.observedAt, now)
    ) {
      await clear(tx, { kind: 'reboot_required', now: at, subject: '', system });
      await tx`UPDATE reboot_observations SET first_required_at = NULL WHERE system = ${system}`;
    } else if (reboot.first_required_at !== null) {
      const held = open.find((item) => item.kind === 'reboot_required');
      const warning = now - reboot.first_required_at.getTime() > effective.rebootWarningDays * DAY;
      await raise(tx, {
        kind: 'reboot_required',
        level:
          warning ||
          (!(observation.kind === 'available' && freshUpdateTime(observation.observedAt, now)) &&
            held?.level === 'warning')
            ? 'warning'
            : 'note',
        now: at,
        reason: 'A reboot is required; confirmed by the local reboot-required marker.',
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
