import { refreshSessionInsight, startHub } from '@heimdall/hub/testing';

import { stopTestServer } from '../../hub/src/testing/postgres.ts';
import { AGENTS_RANGES } from '../src/server/agents-overview-types.ts';
import { readAgentsOverview } from '../src/server/agents-overview.ts';

// Uses the test harness's disposable database, never the dashboard's database URL.
// Run from the repository root: bun packages/dashboard/scripts/benchmark-agents.ts
try {
  await using h = await startHub();
  const { sql } = h.db;
  const now = Date.UTC(2026, 9, 15, 12);
  await sql`INSERT INTO systems (name) VALUES ('bench-1'), ('bench-2'), ('bench-3')`;
  await sql`INSERT INTO current_parsers (harness, version) VALUES ('claude-code', 1), ('codex', 1)`;
  await sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok,
                             cache_read_per_mtok, context_window)
    VALUES ('benchmark-model', '2020-01-01', 'bundled', 1, 2, 0.1, 200000)
  `;
  await sql`
    INSERT INTO projected_sessions (harness, parser_version, system, source, session_id,
                                    path, first_cwd, started_at, ended_at)
    SELECT CASE WHEN n % 3 = 0 THEN 'codex' ELSE 'claude-code' END, 1,
           'bench-' || (1 + n % 3), 'personal', n::text, n || '.jsonl', '/work/project-' || n,
           ${new Date(now)}::timestamptz - CASE WHEN n % 20 = 0 THEN interval '3 days'
             ELSE (n % 31) * interval '24 hours' + interval '1 hour' END,
           ${new Date(now)}::timestamptz - CASE WHEN n % 20 = 0 THEN interval '10 seconds'
             ELSE (n % 31) * interval '24 hours' + interval '2310 seconds' END
    FROM generate_series(1, 800) n
  `;
  await sql`
    INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
    SELECT session_id::bigint, system, source, path, started_at, ended_at FROM projected_sessions
  `;
  await sql`
    INSERT INTO projected_requests (harness, parser_version, system, source, session_id,
                                    request_id, at, model, input_tokens, output_tokens,
                                    cache_read_tokens, cache_write_tokens, generation, byte_offset)
    SELECT s.harness, 1, s.system, s.source, s.session_id, s.session_id || '-' || r,
           s.started_at + (s.ended_at - s.started_at) * (r / 249.0),
           CASE WHEN r % 97 = 0 THEN 'unknown' ELSE 'benchmark-model' END,
           4000, 1000, 2000, 0, s.session_id::bigint, r
    FROM projected_sessions s CROSS JOIN generate_series(0, 249) r
  `;
  await sql`ANALYZE`;
  console.log('Refreshing 800 Sessions with 200,000 requests (40 Sessions span three days).');
  await refreshSessionInsight(sql, { budgetMs: Number.POSITIVE_INFINITY });
  await sql`ANALYZE`;
  for (const range of AGENTS_RANGES) {
    const durations: number[] = [];
    for (let run = 0; run < 6; run += 1) {
      const start = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- measure serial reads without competing queries.
      const view = await readAgentsOverview(sql, { now, range, timeZone: 'Europe/Berlin' });
      durations.push(performance.now() - start);
      if (run === 0) {
        // oxlint-disable-next-line no-await-in-loop -- verify the measured query against raw fixture facts.
        const [expected]: { requests: number }[] = await sql`
          SELECT count(*)::int AS requests FROM projected_requests
          WHERE at >= ${new Date(view.from)} AND at <= ${new Date(now)}
        `;
        if (view.totals.requests !== expected?.requests) {
          throw new Error(`Wrong request count for ${range}.`);
        }
      }
    }
    const first = durations[0] ?? 0;
    const warm = durations.slice(1).toSorted((a, b) => a - b);
    const worstMs = Math.round(Math.max(...durations));
    console.log(
      JSON.stringify({
        firstMs: Math.round(first),
        medianMs: Math.round(warm[2] ?? 0),
        range,
        worstMs,
      }),
    );
  }
} finally {
  await stopTestServer();
}
