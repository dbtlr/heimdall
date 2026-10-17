import {
  FUTURE_SAMPLE_TOLERANCE_MS,
  parseUpdateSubject,
  updateSourceSubject,
  updateSubject,
  freshUpdateTime,
  UPDATE_METADATA_MAX_AGE_MS,
  UpdateManagerSchema,
  PendingUpdateSchema,
} from '@heimdall/schema';
import type { UpdateManager, UpdatesSection } from '@heimdall/schema';
import type { SQL } from 'bun';

import { clear } from './conditions.ts';
import { storableJson } from './storable.ts';

type RecoverySubject = {
  subject: string;
  name: string;
  observed_at: Date;
  pending_update: unknown;
};

export const updateRecovered = ({
  manager,
  name,
  observedAt,
  now,
  available,
}: {
  manager: UpdateManager;
  name: string;
  observedAt: number;
  now: number;
  available: string | null;
}) => {
  if (
    manager.result.kind === 'available' &&
    manager.result.updates.some((update) => update.name === name)
  ) {
    return false;
  }
  const freshCensus =
    manager.installed !== undefined &&
    manager.installed.observedAt >= observedAt &&
    freshUpdateTime(manager.installed.observedAt, now);
  const removed = freshCensus && !manager.installed?.names.includes(name);
  const applied =
    freshCensus &&
    available !== null &&
    (manager.installed?.versions?.some(
      (entry) => entry.name === name && entry.version === available,
    ) ??
      false);
  const fresh =
    freshUpdateTime(manager.observedAt, now) &&
    manager.observedAt >= observedAt &&
    manager.result.kind === 'available' &&
    manager.result.metadataAt !== null &&
    freshUpdateTime(manager.result.metadataAt, now, UPDATE_METADATA_MAX_AGE_MS);
  return removed || applied || fresh;
};

// A package source's Condition ends with its last pending package. Report
// storage and the periodic judgment both end it here, so a later observation
// cannot erase the recovery.
export const clearEmptySource = async (
  tx: SQL,
  { now, subject, system }: { now: Date; subject: string; system: string },
) => {
  const source = parseUpdateSubject(subject);
  if (source === undefined) {
    return;
  }
  const [remaining]: { count: number }[] = await tx`
    SELECT count(*)::int AS count FROM update_subjects
    WHERE system = ${system} AND manager = ${source.manager} AND installation = ${source.installation}
  `;
  if (remaining?.count === 0) {
    await clear(tx, { kind: 'pending_update', now, subject, system });
  }
};

// Per-manager observation time orders cached Reports. Failure replaces coverage,
// but never discards positive evidence or restarts its Hub-confirmed age.
export const storeUpdates = async (
  tx: SQL,
  { receivedAt, section, system }: { receivedAt: number; section: UpdatesSection; system: string },
) => {
  for (const sent of section.managers) {
    const manager = UpdateManagerSchema.parse(sent);
    if (manager.observedAt > receivedAt + FUTURE_SAMPLE_TOLERANCE_MS) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- the caller holds the System lock.
    const accepted: { manager: string }[] = await tx`
      INSERT INTO update_managers (system, manager, installation, observed_at, observation)
      VALUES (${system}, ${manager.manager}, ${manager.installation}, ${new Date(manager.observedAt)},
              ${storableJson(manager)}::text::jsonb)
      ON CONFLICT (system, manager, installation) DO UPDATE SET
        observed_at = excluded.observed_at, observation = excluded.observation, withdrawn = false
      WHERE update_managers.observed_at < excluded.observed_at
        OR (update_managers.withdrawn AND update_managers.observed_at = excluded.observed_at)
        OR update_managers.observed_at > ${new Date(receivedAt + FUTURE_SAMPLE_TOLERANCE_MS)}
      RETURNING manager
    `;
    if (accepted.length === 0) {
      continue;
    }
    // Recovery must survive a later observation arriving before the next
    // periodic judgment. It also resets age before any recurrence is stored.
    // oxlint-disable-next-line no-await-in-loop -- recovery shares the Report's System lock.
    const subjects: RecoverySubject[] = await tx`
      SELECT subject, name, observed_at, pending_update FROM update_subjects
      WHERE system = ${system} AND manager = ${manager.manager} AND installation = ${manager.installation}
    `;
    for (const subject of subjects) {
      if (
        !updateRecovered({
          available: PendingUpdateSchema.parse(subject.pending_update).available,
          manager,
          name: subject.name,
          now: receivedAt,
          observedAt: subject.observed_at.getTime(),
        })
      ) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- the next positive observation starts a new age.
      await tx`DELETE FROM update_subjects WHERE system = ${system} AND subject = ${subject.subject}`;
    }
    if (manager.result.kind !== 'available') {
      // oxlint-disable-next-line no-await-in-loop -- clearing shares the Report's System lock.
      await clearEmptySource(tx, {
        now: new Date(receivedAt),
        subject: updateSourceSubject(manager),
        system,
      });
      continue;
    }
    const fresh =
      freshUpdateTime(manager.observedAt, receivedAt) &&
      manager.result.metadataAt !== null &&
      freshUpdateTime(manager.result.metadataAt, receivedAt, UPDATE_METADATA_MAX_AGE_MS);
    for (const update of manager.result.updates) {
      const securityAt = update.security === true ? new Date(receivedAt) : null;
      // oxlint-disable-next-line no-await-in-loop -- evidence and age share the Report transaction.
      await tx`
        INSERT INTO update_subjects (
          system, subject, manager, installation, name, first_seen_at, security_since,
          observed_at, pending_update
        ) VALUES (${system}, ${updateSubject(manager, update.name)}, ${manager.manager},
                  ${manager.installation}, ${update.name}, ${new Date(receivedAt)}, ${securityAt},
                  ${new Date(manager.observedAt)}, ${storableJson(update)}::text::jsonb)
        ON CONFLICT (system, subject) DO UPDATE SET
          observed_at = excluded.observed_at,
          pending_update = excluded.pending_update,
          security_since = CASE
            WHEN ${fresh && update.security === false} THEN NULL
            ELSE COALESCE(update_subjects.security_since, excluded.security_since)
          END
      `;
    }
    // oxlint-disable-next-line no-await-in-loop -- clearing shares the Report's System lock.
    await clearEmptySource(tx, {
      now: new Date(receivedAt),
      subject: updateSourceSubject(manager),
      system,
    });
  }
  const reboot = section.reboot;
  if (reboot.observedAt > receivedAt + FUTURE_SAMPLE_TOLERANCE_MS) {
    return;
  }
  const first = reboot.kind === 'available' && reboot.required ? new Date(receivedAt) : null;
  const recovered =
    reboot.kind === 'available' &&
    !reboot.required &&
    freshUpdateTime(reboot.observedAt, receivedAt);
  const accepted: { system: string }[] = await tx`
    INSERT INTO reboot_observations (system, observed_at, observation, first_required_at)
    VALUES (${system}, ${new Date(reboot.observedAt)}, ${storableJson(reboot)}::text::jsonb, ${first})
    ON CONFLICT (system) DO UPDATE SET
      observed_at = excluded.observed_at, observation = excluded.observation, withdrawn = false,
      first_required_at = CASE WHEN ${recovered} THEN NULL
        ELSE COALESCE(reboot_observations.first_required_at, excluded.first_required_at) END
    WHERE reboot_observations.observed_at < excluded.observed_at
      OR (reboot_observations.withdrawn AND reboot_observations.observed_at = excluded.observed_at)
      OR reboot_observations.observed_at > ${new Date(receivedAt + FUTURE_SAMPLE_TOLERANCE_MS)}
    RETURNING system
  `;
  if (accepted.length > 0 && recovered) {
    await clear(tx, { kind: 'reboot_required', now: new Date(receivedAt), subject: '', system });
  }
};
