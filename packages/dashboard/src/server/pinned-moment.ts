import type { SQL } from 'bun';

import { projectOf } from './fleet-overview.ts';
import type { MomentSession, MomentVitals, PinnedMoment } from './pinned-moment-types.ts';
import { sessionSpans } from './session-spans.ts';

type SessionRow = {
  cost_usd: string | null;
  first_cwd: string | null;
  first_request_at: Date;
  harness: string;
  last_cwd: string | null;
  last_request_at: Date;
  repository: string | null;
  session_id: string;
  source: string;
  system: string;
};

// A sample older than this before the instant is no reading of it.
const SAMPLE_REACH_MS = 15 * 60_000;

// The Sessions with a stretch running at `at`, on every System, with each
// one's cost, oldest first. The Sessions are the spans' (see sessionSpans), so
// the read costs the stretches since `at`; a Session idle at `at`, between two
// stretches, is not running. No System needs a `systems` row. Call it inside
// a snapshot.
export const readSessionsRunning = async (sql: SQL, at: number): Promise<MomentSession[]> => {
  const instant = new Date(at);
  const rows: SessionRow[] = await sql`
    WITH spans AS MATERIALIZED (${sessionSpans(sql, { from: instant, to: instant })})
    SELECT k.harness, k.system, k.source, k.session_id, k.first_request_at, k.last_request_at,
           s.repository, s.first_cwd, s.last_cwd, t.cost_usd
    FROM spans k
    CROSS JOIN LATERAL (
      SELECT 1
      FROM insight.session_stretches x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (k.harness, k.system, k.source, k.session_id)
        AND x.started_at <= ${instant} AND x.ended_at >= ${instant}
      LIMIT 1
    ) running
    LEFT JOIN LATERAL (
      SELECT x.repository, x.first_cwd, x.last_cwd
      FROM insight.sessions x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (k.harness, k.system, k.source, k.session_id)
      OFFSET 0
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT x.cost_usd
      FROM insight.session_totals x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (k.harness, k.system, k.source, k.session_id)
      OFFSET 0
    ) t ON true
    ORDER BY k.first_request_at, k.system, k.session_id
  `;
  return rows.map((row) => ({
    costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd),
    endedAt: row.last_request_at.getTime(),
    harness: row.harness,
    project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
    sessionId: row.session_id,
    source: row.source,
    startedAt: row.first_request_at.getTime(),
    system: row.system,
  }));
};

type VitalsRow = {
  cpu: number | null;
  load: number | null;
  memory: number | null;
  t: Date;
};

// The System's Vitals at `at`: its newest sample within 15 minutes before it,
// else the 5-minute rollup holding it.
export const readVitalsAt = async (
  sql: SQL,
  { at, system }: { at: number; system: string },
): Promise<MomentVitals | undefined> => {
  const instant = new Date(at);
  const [sample]: VitalsRow[] = await sql`
    SELECT t, cpu_busy_percent AS cpu, load_1 AS load,
           memory_used_bytes::float8 * 100 / NULLIF(memory_total_bytes, 0) AS memory
    FROM vitals_samples
    WHERE system = ${system} AND t <= ${instant} AND t >= ${new Date(at - SAMPLE_REACH_MS)}
    ORDER BY t DESC
    LIMIT 1
  `;
  const [row]: VitalsRow[] =
    sample === undefined
      ? await sql`
          SELECT bucket AS t, (cpu_busy_sum / NULLIF(samples, 0))::float8 AS cpu,
                 (load_1_sum / NULLIF(samples, 0))::float8 AS load,
                 (memory_used_sum / NULLIF(samples, 0) / NULLIF(memory_total_max, 0) * 100)::float8 AS memory
          FROM vitals_rollups
          WHERE system = ${system}
            AND bucket = date_bin('5 minutes', ${instant}::timestamptz, timestamptz '2000-01-01 00:00:00+00')
        `
      : [sample];
  return row === undefined
    ? undefined
    : {
        cpu: row.cpu ?? undefined,
        load: row.load ?? undefined,
        memory: row.memory ?? undefined,
        t: row.t.getTime(),
      };
};

// The Sessions running at `at`, and `system`'s Vitals then when one is named,
// in one snapshot.
export const readPinnedMoment = (
  sql: SQL,
  { at, system }: { at: number; system: string | undefined },
): Promise<PinnedMoment> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const [sessions, vitals] = await Promise.all([
      readSessionsRunning(tx, at),
      system === undefined ? undefined : readVitalsAt(tx, { at, system }),
    ]);
    return { at, sessions, system, vitals };
  });
