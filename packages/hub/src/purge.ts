import type { SQL } from 'bun';

import { holdProjection } from './projection.ts';
import { retryOnDeadlock } from './transcripts.ts';
import type { Removed } from './transcripts.ts';

// What `purgeSystem` did: refused a System that is paired or holds a pending
// Pairing code; found nothing of it, or only the transcripts it was told to
// keep; or purged it, with what of its transcripts it deleted when told to.
export type Purged =
  | { kind: 'paired' }
  | { kind: 'pending_code' }
  | { kind: 'nothing' }
  | { kind: 'transcripts_only' }
  | { kind: 'purged'; transcripts: Removed | undefined };

// A purge of years of Vitals can outlast the usual statement timeout.
const PURGE_TIMEOUT = '10min';

// What a System's Reports left, children before the rows they reference and
// the System's row last. Vitals go before Harness process readings, the order
// the Vitals prune deletes them in, so the two cannot deadlock. Each statement
// takes the System's name as $1.
const HISTORY = [
  'DELETE FROM condition_transitions WHERE condition IN (SELECT id FROM conditions WHERE system = $1)',
  'DELETE FROM load_episode_samples WHERE condition IN (SELECT id FROM conditions WHERE system = $1)',
  'DELETE FROM conditions WHERE system = $1',
  'DELETE FROM deliveries WHERE system = $1',
  'DELETE FROM condition_limits WHERE system = $1',
  'DELETE FROM load_evaluations WHERE system = $1',
  'DELETE FROM hot_process_evaluations WHERE system = $1',
  'DELETE FROM vitals_samples WHERE system = $1',
  'DELETE FROM vitals_rollups WHERE system = $1',
  'DELETE FROM disk_rollups WHERE system = $1',
  'DELETE FROM harness_process_samples WHERE process IN (SELECT id FROM harness_processes WHERE system = $1)',
  'DELETE FROM harness_process_rollups WHERE process IN (SELECT id FROM harness_processes WHERE system = $1)',
  'DELETE FROM harness_processes WHERE system = $1',
  'DELETE FROM harness_installs WHERE system = $1',
  'DELETE FROM record_sets WHERE system = $1',
  'DELETE FROM mirrored_records WHERE system = $1',
  'DELETE FROM records_first_mirrored WHERE system = $1',
  'DELETE FROM run_sets WHERE system = $1',
  'DELETE FROM mirrored_runs WHERE system = $1',
  'DELETE FROM check_sets WHERE system = $1',
  'DELETE FROM update_managers WHERE system = $1',
  'DELETE FROM update_subjects WHERE system = $1',
  'DELETE FROM reboot_observations WHERE system = $1',
  'DELETE FROM transcript_sources WHERE system = $1',
  'DELETE FROM systems WHERE name = $1',
] as const;

// A System's transcripts and every row derived from them (ADR-0014). The
// stale marks come last, since deleting what they mark adds more.
const TRANSCRIPTS = [
  'DELETE FROM parse_progress WHERE generation IN (SELECT id FROM transcript_generations WHERE system = $1)',
  'DELETE FROM projected_holders WHERE system = $1',
  'DELETE FROM projected_requests WHERE system = $1',
  'DELETE FROM projected_tool_calls WHERE system = $1',
  'DELETE FROM projected_subagents WHERE system = $1',
  'DELETE FROM projected_sessions WHERE system = $1',
  'DELETE FROM rederiving_sessions WHERE system = $1',
  'DELETE FROM stored_session_stretches WHERE system = $1',
  'DELETE FROM stored_session_totals WHERE system = $1',
  'DELETE FROM stored_session_model_totals WHERE system = $1',
  'DELETE FROM transcript_chunks WHERE generation IN (SELECT id FROM transcript_generations WHERE system = $1)',
  'DELETE FROM transcript_generations WHERE system = $1',
  'DELETE FROM transcript_source_harnesses WHERE system = $1',
  'DELETE FROM stale_sessions WHERE system = $1',
  'DELETE FROM stale_ranges WHERE system = $1',
] as const;

// Runs each statement with `params` in order and answers how many rows they
// deleted in all.
const deleteAll = async (tx: SQL, statements: readonly string[], params: readonly string[]) => {
  let deleted = 0;
  for (const statement of statements) {
    // oxlint-disable-next-line no-await-in-loop -- children go before their parents.
    const result = await tx.unsafe(statement, [...params]);
    deleted += result.count;
  }
  return deleted;
};

// Deletes every row the Hub holds for `system`, which must be unpaired with no
// pending Pairing code, in one transaction. Its transcripts and the Session
// insight derived from them stay unless `transcripts`, which deletes them and
// their generations' rows outright, so nothing refuses the name's paths again.
// Kept transcripts recompute their stretches without the deleted Harness
// processes, as the stale marks their deletion adds say to. A refresh that
// marks the same Sessions stale can deadlock with the purge, which then tries
// again, as a transcript delete does.
export const purgeSystem = (
  sql: SQL,
  options: { system: string; transcripts: boolean },
): Promise<Purged> =>
  retryOnDeadlock(
    (ms) => Bun.sleep(ms),
    () => purgeOnce(sql, options),
  );

// One transaction of `purgeSystem`.
const purgeOnce = (
  sql: SQL,
  { system, transcripts }: { system: string; transcripts: boolean },
): Promise<Purged> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${PURGE_TIMEOUT}'`);
    // As a transcript delete does, so no projection batch stores facts of a
    // generation this deletes.
    if (transcripts) {
      await holdProjection(tx);
    }
    // The code row first, then the token, as unpair and redemption take them.
    const codes: unknown[] = await tx`
      SELECT 1 FROM pairing_codes WHERE system = ${system} FOR UPDATE
    `;
    const tokens: unknown[] = await tx`
      SELECT 1 FROM paired_systems WHERE system = ${system} FOR UPDATE
    `;
    if (tokens.length > 0) {
      return { kind: 'paired' };
    }
    if (codes.length > 0) {
      return { kind: 'pending_code' };
    }
    // Generation rows lock before the System's row, as uploads take them.
    const generations: { deleted_at: Date | null; stored_bytes: string }[] = await tx`
      SELECT deleted_at, stored_bytes FROM transcript_generations
      WHERE system = ${system}
      ORDER BY id
      FOR UPDATE
    `;
    const harnesses: unknown[] = await tx`
      SELECT 1 FROM transcript_source_harnesses WHERE system = ${system}
    `;
    await tx`SELECT 1 FROM systems WHERE name = ${system} FOR UPDATE`;
    let deleted = await deleteAll(tx, HISTORY, [system]);
    if (transcripts) {
      deleted += await deleteAll(tx, TRANSCRIPTS, [system]);
    }
    if (deleted === 0) {
      const kept = generations.length > 0 || harnesses.length > 0;
      return { kind: kept && !transcripts ? 'transcripts_only' : 'nothing' };
    }
    // Generations deleted before hold no transcripts to count.
    const live = generations.filter((row) => row.deleted_at === null);
    return {
      kind: 'purged',
      transcripts: transcripts
        ? {
            bytes: live.reduce((sum, row) => sum + Number(row.stored_bytes), 0),
            generations: live.length,
          }
        : undefined,
    };
  });

// What `purgeService` did: refused a Service its System still records, found
// nothing of it, or purged it.
export type PurgedService = { kind: 'recorded' } | { kind: 'nothing' } | { kind: 'purged' };

// What a Service's checks left: its Service down Conditions, their Timeline,
// and their deliveries. Each statement takes the System's name as $1 and the
// Service's as $2.
const SERVICE_HISTORY = [
  `DELETE FROM condition_transitions WHERE condition IN (
     SELECT id FROM conditions WHERE system = $1 AND kind = 'service_down' AND subject = $2
   )`,
  `DELETE FROM conditions WHERE system = $1 AND kind = 'service_down' AND subject = $2`,
  `DELETE FROM deliveries WHERE system = $1 AND kind = 'service_down' AND subject = $2`,
] as const;

// Deletes every Condition the Hub holds for `service` on `system`, with its
// Timeline and deliveries, in one transaction under the System's row lock, so
// it orders with the System's Reports and Service down evaluation (ADR-0005).
// It refuses while the Hub mirrors a record of the Service; an unreadable
// service record does not hold it back, since the operator names a Service
// they know is gone. An open Service down goes too, and its delivery with it,
// so no recovered message follows.
export const purgeService = (
  sql: SQL,
  { service, system }: { service: string; system: string },
): Promise<PurgedService> =>
  sql.begin(async (tx) => {
    const held: unknown[] = await tx`SELECT 1 FROM systems WHERE name = ${system} FOR UPDATE`;
    if (held.length === 0) {
      return { kind: 'nothing' };
    }
    const recorded: unknown[] = await tx`
      SELECT 1 FROM mirrored_records
      WHERE system = ${system} AND kind = 'service' AND name = ${service}
    `;
    if (recorded.length > 0) {
      return { kind: 'recorded' };
    }
    const deleted = await deleteAll(tx, SERVICE_HISTORY, [system, service]);
    return { kind: deleted === 0 ? 'nothing' : 'purged' };
  });
