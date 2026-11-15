import type { SQL } from 'bun';

import type { HubCheck, HubStatus, HubTable } from './hub-status-types.ts';

// Twice the scheduling interval leaves room for a pass's work. Listening uses
// its existing two-minute outage rule. Keep aligned with serve.ts's intervals.
export const HUB_OVERDUE_MS = {
  conditions: 120_000,
  delivery: 60_000,
  listening: 120_000,
  parse: 30_000,
  prune: 7_200_000,
  refresh: 30_000,
  upstreams: 600_000,
};
const SYSTEM_OVERDUE_MS = 600_000;
const SLEEPING_SYSTEM_OVERDUE_MS = 7 * 86_400_000;
const stamp = (date: Date | null | undefined) =>
  date?.toISOString().replace('T', ' ').replace('.000Z', ' UTC') ?? 'unknown';
const bytes = (value: number | string) => `${(Number(value) / 1024 ** 3).toFixed(2)} GiB`;
type Runtime = {
  version: string;
  started_at: Date;
  delivery_configured: boolean;
  last_runs: Record<string, number>;
};

// A missing table is expected during an upgrade. Do this outside the snapshot:
// a missing-relation error would otherwise abort the whole transaction.
const readRuntime = async (sql: SQL): Promise<Runtime | undefined> => {
  try {
    const [row]: Runtime[] =
      await sql`SELECT version, started_at, delivery_configured, last_runs FROM hub_status`;
    return row;
  } catch (error) {
    if (error instanceof Error && 'errno' in error && error.errno === '42P01') {
      return undefined;
    }
    throw error;
  }
};

// Direct database reads, with counts only from parser failures. No transcript
// content or delivery configuration is selected or sent to the browser.
export const readHubStatus = async (sql: SQL, now: number): Promise<HubStatus> => {
  const runtime = await readRuntime(sql);
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const checks: HubCheck[] = [];
    const tables: HubTable[] = [];
    const add = (part: string, state: HubCheck['state'], text: string, detail = '') => {
      checks.push({ detail, part, state, text });
    };
    const timer = (name: keyof typeof HUB_OVERDUE_MS) => {
      const last = runtime?.last_runs[name];
      const base = last ?? runtime?.started_at.getTime();
      if (base === undefined) {
        return 'unknown';
      }
      if (now - base > (HUB_OVERDUE_MS[name] ?? 0)) {
        return 'overdue';
      }
      return last === undefined ? 'awaiting first pass' : 'current';
    };
    const timerState = (name: keyof typeof HUB_OVERDUE_MS): HubCheck['state'] => {
      if (timer(name) === 'unknown') {
        return 'unknown';
      }
      return timer(name) === 'overdue' ? 'warning' : 'ok';
    };
    const lastPass = (name: keyof typeof HUB_OVERDUE_MS) => {
      const at = runtime?.last_runs[name];
      return at === undefined ? 'unknown' : stamp(new Date(at));
    };
    const [listening]: { heard_at: Date | null; listening_since: Date | null }[] =
      await tx`SELECT heard_at, listening_since FROM hub_listening`;
    let listeningState: HubCheck['state'] = 'unknown';
    if (listening?.heard_at != null) {
      listeningState =
        now - listening.heard_at.getTime() > HUB_OVERDUE_MS.listening ? 'warning' : 'ok';
    }
    add(
      'Listening',
      listeningState,
      `Since ${stamp(listening?.listening_since)}`,
      `Last recorded ${stamp(listening?.heard_at)} · Hub v${runtime?.version ?? 'unknown'} · started ${stamp(runtime?.started_at)}`,
    );
    const migrations: { version: number; applied_at: Date }[] =
      await tx`SELECT version, applied_at FROM schema_migrations ORDER BY version DESC`;
    const [size]: { bytes: string }[] =
      await tx`SELECT pg_database_size(current_database())::text AS bytes`;
    add(
      'Database',
      'ok',
      `${bytes(size?.bytes ?? 0)} · schema ${migrations[0]?.version ?? 'unknown'}`,
      `Applied ${stamp(migrations[0]?.applied_at)}`,
    );
    const systems: {
      name: string;
      last_seen_at: Date | null;
      collector_version: string | null;
      sleeps: boolean | null;
      clock_offset_ms: number | null;
      spool_bytes: string | null;
      spool_oldest_at: Date | null;
    }[] = await tx`
      SELECT p.system AS name, s.last_seen_at, s.collector_version, s.sleeps, s.clock_offset_ms,
        t.spool_bytes::text, t.spool_oldest_at FROM paired_systems p
      LEFT JOIN systems s ON s.name = p.system LEFT JOIN transcript_sources t ON t.system = p.system ORDER BY p.system`;
    const quiet = systems.filter(
      (s) =>
        s.last_seen_at === null ||
        now - s.last_seen_at.getTime() >
          (s.sleeps === true ? SLEEPING_SYSTEM_OVERDUE_MS : SYSTEM_OVERDUE_MS),
    );
    add(
      'Intake',
      quiet.length ? 'warning' : 'ok',
      `${systems.length} Systems paired · ${quiet.length} not reporting`,
      quiet.map((s) => s.name).join(', '),
    );
    tables.push({
      columns: ['System', 'Last Report', 'Collector', 'Clock offset', 'Transcripts waiting'],
      rows: systems.map((s) => [
        s.name,
        `${stamp(s.last_seen_at)}${s.sleeps ? ' · sleeps' : ''}`,
        s.collector_version ?? 'unknown',
        s.clock_offset_ms === null ? 'unknown' : `${s.clock_offset_ms / 1000} s`,
        `${s.spool_bytes ?? '0'} B · oldest ${stamp(s.spool_oldest_at)}`,
      ]),
      title: 'Systems and Collectors',
    });
    const parts: { system: string; part: string; budget: string | null; unreadable: number }[] =
      await tx`
      SELECT r.system, 'Records' AS part, r.over_budget_bytes::text AS budget, jsonb_array_length(r.unreadable)::int AS unreadable
        FROM record_sets r JOIN paired_systems p ON p.system = r.system
      UNION ALL SELECT r.system, 'Runs', r.over_budget_bytes::text, jsonb_array_length(r.unreadable)::int
        FROM run_sets r JOIN paired_systems p ON p.system = r.system
      UNION ALL SELECT r.system, 'Checks', (coalesce(r.files_over_budget_bytes, 0) + coalesce(r.services_over_budget_bytes, 0))::text, 0
        FROM check_sets r JOIN paired_systems p ON p.system = r.system`;
    tables.push({
      columns: ['System', 'Part', 'Over budget', 'Unreadable'],
      rows: parts
        .filter((p) => Number(p.budget) > 0 || p.unreadable > 0)
        .map((p) => [p.system, p.part, `${p.budget ?? 0} B`, String(p.unreadable)]),
      title: 'Report parts needing attention',
    });
    const codes: { system: string; expires_at: Date }[] =
      await tx`SELECT system, expires_at FROM pairing_codes WHERE expires_at > ${new Date(now)} ORDER BY system`;
    tables.push({
      columns: ['System', 'Expires'],
      rows: codes.map((c) => [c.system, stamp(c.expires_at)]),
      title: 'Pending Pairing codes',
    });
    const parsers: {
      harness: string;
      version: number;
      target: number;
      failed: number;
      attempts: number;
      behind: string;
      read: number;
      total: number;
    }[] = await tx`
      WITH versions AS (
        SELECT harness, version FROM current_parsers UNION SELECT harness, parser_version FROM parse_progress
      ), targets AS (SELECT harness, max(version) AS target FROM versions GROUP BY harness)
      SELECT t.harness, coalesce(c.version, 0) AS version, t.target,
        count(*) FILTER (WHERE p.failed_at IS NOT NULL)::int AS failed,
        coalesce(max(p.failed_attempts), 0)::int AS attempts,
        coalesce(sum(greatest(g.held - coalesce(p.parsed_through, 0), 0)), 0)::text AS behind,
        count(*) FILTER (WHERE coalesce(p.parsed_through, 0) >= g.held)::int AS read, count(g.id)::int AS total
      FROM targets t LEFT JOIN current_parsers c ON c.harness = t.harness
      LEFT JOIN (
        SELECT h.harness, g.id FROM transcript_generations g JOIN transcript_source_harnesses h
          ON h.system = g.system AND h.source = g.source
        UNION SELECT harness, generation FROM parse_progress
      ) generations ON generations.harness = t.harness
      LEFT JOIN transcript_generations g ON g.id = generations.id AND g.deleted_at IS NULL
      LEFT JOIN parse_progress p ON p.harness = t.harness AND p.parser_version = t.target AND p.generation = g.id GROUP BY t.harness, c.version, t.target ORDER BY t.harness`;
    const failed = parsers.reduce((sum, p) => sum + p.failed, 0);
    const rebuilding = parsers.some((p) => p.target > p.version);
    const behind = parsers.reduce((sum, p) => sum + Number(p.behind), 0);
    add(
      'Session insight',
      failed || timer('parse') === 'overdue' ? 'warning' : timerState('parse'),
      `${failed} generation failed · ${rebuilding ? 'Parser rebuilding' : `${behind} B behind`} · parse pass ${timer('parse')}`,
      rebuilding && timer('parse') === 'overdue'
        ? 'Parser rebuild stalled: parse pass overdue'
        : `Last parse pass ${lastPass('parse')}. Failure reasons are kept out of the dashboard.`,
    );
    tables.push({
      columns: ['Harness', 'Parser', 'Progress', 'Failed'],
      rows: parsers.map((p) => [
        p.harness,
        `v${p.version}`,
        `${p.target > p.version ? `Rebuilding to v${p.target}: ${p.read} of ${p.total} generations · ` : ''}${p.behind} B behind`,
        `${p.failed} generations · up to ${p.attempts} attempts`,
      ]),
      title: 'Session insight',
    });
    const failures: { system: string; source: string; failed_attempts: number; failed_at: Date }[] =
      await tx`
      SELECT g.system, g.source, p.failed_attempts, p.failed_at FROM parse_progress p
      JOIN transcript_generations g ON g.id = p.generation
      WHERE g.deleted_at IS NULL AND p.failed_at IS NOT NULL AND p.parser_version >= coalesce((SELECT version FROM current_parsers c WHERE c.harness = p.harness), 0)
      ORDER BY g.system, g.source`;
    tables.push({
      columns: ['System', 'Source', 'Attempts', 'Failed at'],
      rows: failures.map((f) => [
        f.system,
        f.source,
        String(f.failed_attempts),
        stamp(f.failed_at),
      ]),
      title: 'Failed generations',
    });
    const [stale]: { sessions: number; ranges: number; rederiving: number; retries: number }[] =
      await tx`SELECT
      (SELECT count(*)::int FROM stale_sessions) AS sessions,
      (SELECT count(*)::int FROM stale_ranges) AS ranges,
      (SELECT count(*)::int FROM rederiving_sessions) AS rederiving,
      (SELECT count(*)::int FROM stale_sessions WHERE attempts > 0) AS retries`;
    add(
      'Stored Session totals',
      stale &&
        (stale.retries > 0 ||
          (stale.sessions + stale.ranges + stale.rederiving > 0 && timer('refresh') === 'overdue'))
        ? 'warning'
        : timerState('refresh'),
      `${stale?.sessions ?? 0} Sessions waiting to refresh · ${stale?.ranges ?? 0} ranges · ${stale?.rederiving ?? 0} rederiving · ${stale?.retries ?? 0} refresh retry`,
      `Refresh pass ${timer('refresh')} · last completed ${lastPass('refresh')}`,
    );
    const evaluations: { system: string; load: Date | null; process: Date | null }[] = await tx`
      SELECT p.system, l.through AS load, h.through AS process FROM paired_systems p
      LEFT JOIN load_evaluations l ON l.system = p.system
      LEFT JOIN hot_process_evaluations h ON h.system = p.system ORDER BY p.system`;
    tables.push({
      columns: ['System', 'Load evaluated through', 'Hot processes evaluated through'],
      rows: evaluations.map((e) => [e.system, stamp(e.load), stamp(e.process)]),
      title: 'Condition evaluations',
    });
    add(
      'Conditions',
      timerState('conditions'),
      `Condition evaluation ${timer('conditions')}`,
      `Last pass ${lastPass('conditions')}`,
    );
    const [delivery]: { failing_since: Date | null; open: number; last_push: Date | null }[] =
      await tx`SELECT failing_since,
      (SELECT count(*)::int FROM deliveries WHERE closed_at IS NULL) AS open,
      (SELECT max(pushed_at) FROM deliveries) AS last_push FROM delivery_status`;
    let deliveryState = timerState('delivery');
    let deliveryText = 'Configuration unknown';
    if (runtime !== undefined) {
      deliveryText = runtime.delivery_configured
        ? `Configured · pass ${timer('delivery')}`
        : 'Not configured';
      if (!runtime.delivery_configured) {
        deliveryState = 'ok';
      }
    }
    if (delivery?.failing_since != null) {
      deliveryState = 'warning';
      deliveryText = `Failing since ${stamp(delivery.failing_since)}`;
    }
    add(
      'Alert delivery',
      deliveryState,
      deliveryText,
      `${delivery?.open ?? 0} open deliveries · last push ${stamp(delivery?.last_push)} · last delivery pass ${lastPass('delivery')}`,
    );
    const silences: { system: string; until: Date }[] =
      await tx`SELECT system, until FROM silences WHERE until > ${new Date(now)} ORDER BY system`;
    tables.push({
      columns: ['System', 'Until'],
      rows: silences.map((s) => [s.system, stamp(s.until)]),
      title: 'Active silences',
    });
    const [upstream]: { total: number; failed: number }[] =
      await tx`SELECT count(*)::int AS total, count(*) FILTER (WHERE failure IS NOT NULL)::int AS failed FROM upstream_checks`;
    add(
      'Upstream checks',
      upstream?.failed ? 'warning' : timerState('upstreams'),
      `${upstream?.total ?? 0} upstreams · ${upstream?.failed ?? 0} failing · pass ${timer('upstreams')}`,
      `Last pass ${lastPass('upstreams')}`,
    );
    const [prices]: { models: number; configured: number }[] =
      await tx`SELECT count(DISTINCT model)::int AS models, count(DISTINCT model) FILTER (WHERE source = 'configured')::int AS configured FROM model_prices`;
    const [unpriced]: { requests: string }[] =
      await tx`SELECT coalesce(sum(unpriced_requests), 0)::text AS requests FROM insight.session_model_totals`;
    add(
      'Price table',
      'ok',
      `${prices?.models ?? 0} models · ${prices?.configured ?? 0} configured`,
      `${unpriced?.requests ?? 0} unpriced requests in stored Session totals`,
    );
    const [oldest]: { raw: Date | null; rollup: Date | null }[] = await tx`
      SELECT min(v.t) AS raw, min(r.bucket) AS rollup FROM systems s
      LEFT JOIN LATERAL (SELECT t FROM vitals_samples WHERE system = s.name ORDER BY t LIMIT 1) v ON true
      LEFT JOIN LATERAL (SELECT bucket FROM vitals_rollups WHERE system = s.name ORDER BY bucket LIMIT 1) r ON true`;
    add(
      'Retention',
      timerState('prune'),
      `Prune pass ${timer('prune')}`,
      `Last prune ${lastPass('prune')} · raw Vitals: 14 days · rollups: 365 days · oldest raw ${stamp(oldest?.raw)} · oldest rollup ${stamp(oldest?.rollup)}`,
    );
    const storage: { name: string; bytes: string }[] =
      await tx`SELECT relname AS name, pg_total_relation_size(relid)::text AS bytes FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8`;
    tables.push({
      columns: ['Table', 'Size'],
      rows: storage.map((s) => [s.name, bytes(s.bytes)]),
      title: 'Storage',
    });
    const [archive]: {
      generations: string;
      held: string;
      stored: string;
      uploaded: Date | null;
    }[] =
      await tx`SELECT count(*)::text AS generations, coalesce(sum(held), 0)::text AS held, coalesce(sum(stored_bytes), 0)::text AS stored, max(last_upload_at) AS uploaded FROM transcript_generations`;
    if (archive) {
      tables.push({
        columns: ['Generations', 'As written', 'Stored', 'Last upload'],
        rows: [
          [
            archive.generations,
            bytes(archive.held),
            bytes(archive.stored),
            stamp(archive.uploaded),
          ],
        ],
        title: 'Transcript archive',
      });
    }
    tables.push({
      columns: ['Migration', 'Applied'],
      rows: migrations.map((m) => [String(m.version), stamp(m.applied_at)]),
      title: 'Migrations applied',
    });
    return {
      checks,
      started: stamp(runtime?.started_at),
      tables,
      version: runtime?.version ?? 'unknown',
    };
  });
};
