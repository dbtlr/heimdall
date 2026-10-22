import { expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { migrate } from './migrations.ts';
import { issueCode } from './pairing.ts';
import { refreshSessionInsight } from './stored-insight.ts';
import { configArgs, hubConfig, invoke } from './testing/cli.ts';
import { testDatabase } from './testing/postgres.ts';
import { timeline } from './testing/timeline.ts';
import { storeToken } from './tokens.ts';

const AT = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));

// Tables that hold nothing of any one System, which a purge leaves alone.
const FLEET_TABLES = new Set([
  'current_parsers',
  'delivery_status',
  'hub_listening',
  'model_prices',
  'schema_migrations',
]);

// Tables a paired System or a pending Pairing code fills, which a purge refuses.
const PAIRING_TABLES = new Set(['paired_systems', 'pairing_codes', 'silences']);

// What a purge without --transcripts keeps: the transcripts and every row
// derived from them.
const TRANSCRIPT_TABLES = new Set([
  'parse_progress',
  'projected_holders',
  'projected_requests',
  'projected_sessions',
  'projected_subagents',
  'projected_tool_calls',
  'rederiving_sessions',
  'stale_ranges',
  'stale_sessions',
  'stored_session_model_totals',
  'stored_session_stretches',
  'stored_session_totals',
  'transcript_chunks',
  'transcript_generations',
  'transcript_source_harnesses',
]);

// Every table but the fleet-wide and pairing ones, with the column that names
// its System: `name` for `systems`, `system`, or none for a table that names it
// only through a parent.
const perSystemTables = async (sql: SQL) => {
  const rows: { column: string | null; name: string }[] = await sql`
    SELECT t.table_name AS name,
           CASE WHEN t.table_name = 'systems' THEN 'name'
                WHEN EXISTS (
                  SELECT 1 FROM information_schema.columns c
                  WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
                    AND c.column_name = 'system'
                ) THEN 'system'
           END AS column
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `;
  return rows.filter(({ name }) => !FLEET_TABLES.has(name) && !PAIRING_TABLES.has(name));
};

// Rows per table: all of them, and those that name `system`.
const countRows = async (sql: SQL, system: string) => {
  const counts = new Map<string, { all: number; named: number | null }>();
  for (const { column, name } of await perSystemTables(sql)) {
    // oxlint-disable-next-line no-await-in-loop -- a few dozen small tables.
    const [row]: { all: number; named: number | null }[] = await sql.unsafe(
      `SELECT count(*)::int AS all, ${column === null ? 'NULL::int' : `(count(*) FILTER (WHERE ${column} = $1::text))::int`} AS named FROM ${name}`,
      column === null ? [] : [system],
    );
    counts.set(name, row ?? { all: 0, named: null });
  }
  return counts;
};

// One row of everything the Hub keeps for `system`, as a long-lived System
// with Reports, Conditions, Harness processes, and archived transcripts leaves.
const seedSystem = async (sql: SQL, system: string, generation: number) => {
  await sql`INSERT INTO systems (name, last_seen_at) VALUES (${system}, ${AT})`;
  await sql`
    INSERT INTO vitals_samples (
      system, t, cpu_busy_percent, memory_total_bytes, memory_used_bytes, load_1, load_5,
      load_15, uptime_seconds, disks, collector_cpu_percent, collector_rss_bytes
    ) VALUES (${system}, ${AT}, 1, 2, 1, 0, 0, 0, 60, '[]', 0, 1)
  `;
  await sql`
    INSERT INTO vitals_rollups (
      system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max, memory_used_min,
      memory_used_sum, memory_used_max, memory_total_max, load_1_min, load_1_sum, load_1_max,
      uptime_min, collector_cpu_sum, collector_cpu_max, collector_rss_sum, collector_rss_max
    ) VALUES (${system}, ${AT}, 1, 1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 60, 0, 0, 1, 1)
  `;
  await sql`
    INSERT INTO disk_rollups (system, bucket, mount, used_max, total_max)
    VALUES (${system}, ${AT}, '/', 1, 2)
  `;
  const [condition]: { id: string }[] = await sql`
    INSERT INTO conditions (
      system, kind, subject, raised_at, raised_reason, latest_at, latest_reason, level
    ) VALUES (${system}, 'cpu_load', '', ${AT}, 'busy', ${AT}, 'busy', 'alert')
    RETURNING id
  `;
  await sql`
    INSERT INTO condition_transitions (condition, action, level, at, reason)
    VALUES (${condition?.id}, 'raised', 'alert', ${AT}, 'busy')
  `;
  await sql`
    INSERT INTO load_episode_samples (condition, sample_from, sample_until)
    VALUES (${condition?.id}, ${AT}, ${AT})
  `;
  await sql`
    INSERT INTO deliveries (system, kind, subject, alert_since, pushed_at)
    VALUES (${system}, 'cpu_load', '', ${AT}, ${AT})
  `;
  await sql`INSERT INTO condition_limits (system, limits) VALUES (${system}, '{}')`;
  await sql`INSERT INTO load_evaluations (system, through) VALUES (${system}, ${AT})`;
  await sql`INSERT INTO hot_process_evaluations (system, through) VALUES (${system}, ${AT})`;
  await sql`INSERT INTO record_sets (system, sent_at, received_at) VALUES (${system}, ${AT}, ${AT})`;
  await sql`
    INSERT INTO mirrored_records (system, kind, name, record)
    VALUES (${system}, 'service', 'web', '{}')
  `;
  await sql`
    INSERT INTO records_first_mirrored (system, kind, name, first_mirrored_at)
    VALUES (${system}, 'service', 'web', ${AT})
  `;
  await sql`INSERT INTO run_sets (system, sent_at, received_at) VALUES (${system}, ${AT}, ${AT})`;
  await sql`INSERT INTO mirrored_runs (system, job, latest_run) VALUES (${system}, 'backup', '{}')`;
  await sql`INSERT INTO check_sets (system, sent_at, received_at) VALUES (${system}, ${AT}, ${AT})`;
  await sql`INSERT INTO harness_installs (system, installs, sent_at) VALUES (${system}, '[]', ${AT})`;
  const [process]: { id: string }[] = await sql`
    INSERT INTO harness_processes (
      system, harness, pid, started_at, peak_rss_bytes, last_seen_at, sent_at
    ) VALUES (${system}, 'claude-code', 42, ${AT}, 1, ${AT}, ${AT})
    RETURNING id
  `;
  await sql`
    INSERT INTO harness_process_samples (process, t, cpu_micros, rss_bytes)
    VALUES (${process?.id}, ${AT}, 1, 1)
  `;
  await sql`
    INSERT INTO harness_process_rollups (
      process, bucket, samples, cpu_micros_min, cpu_micros_max, rss_min, rss_sum, rss_max
    ) VALUES (${process?.id}, ${AT}, 1, 1, 1, 1, 1, 1)
  `;
  await sql`
    INSERT INTO update_managers (system, manager, installation, observed_at, observation)
    VALUES (${system}, 'apt', '', ${AT}, '{}')
  `;
  await sql`
    INSERT INTO update_subjects (
      system, subject, manager, installation, name, first_seen_at, observed_at, pending_update
    ) VALUES (${system}, 'curl', 'apt', '', 'curl', ${AT}, ${AT}, '{}')
  `;
  await sql`
    INSERT INTO reboot_observations (system, observed_at, observation)
    VALUES (${system}, ${AT}, '{}')
  `;
  await sql`
    INSERT INTO transcript_sources (system, sources, spool_bytes, sent_at)
    VALUES (${system}, '[]', 0, ${AT})
  `;
  await sql`
    INSERT INTO transcript_source_harnesses (system, source, harness, sent_at)
    VALUES (${system}, 'claude-code', 'claude-code', ${AT})
  `;
  await sql`
    INSERT INTO transcript_generations (
      id, system, source, path, held, stored_bytes, opened_at, last_upload_at
    ) VALUES (${generation}, ${system}, 'claude-code', 'session.jsonl', 1, 1, ${AT}, ${AT})
  `;
  await sql`
    INSERT INTO transcript_chunks (generation, offset_bytes, length, content)
    VALUES (${generation}, 0, 1, ${Buffer.from('x')})
  `;
  await sql`
    INSERT INTO parse_progress (harness, parser_version, generation, parsed_through, held_seen)
    VALUES ('claude-code', 1, ${generation}, 1, 1)
  `;
  const session = { harness: 'claude-code', session_id: 's-1', source: 'claude-code', system };
  await sql`INSERT INTO projected_sessions ${sql({ ...session, parser_version: 1 })}`;
  await sql`INSERT INTO projected_subagents ${sql({ ...session, agent_id: 'a-1', parser_version: 1 })}`;
  await sql`
    INSERT INTO projected_requests ${sql({
      ...session,
      at: AT,
      byte_offset: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      generation,
      input_tokens: 1,
      model: 'claude-opus-5-5',
      output_tokens: 1,
      parser_version: 1,
      request_id: 'r-1',
    })}
  `;
  await sql`
    INSERT INTO projected_tool_calls ${sql({
      ...session,
      at: AT,
      byte_offset: 0,
      call_id: 'c-1',
      generation,
      kind: 'builtin',
      name: 'Read',
      parser_version: 1,
    })}
  `;
  await sql`
    INSERT INTO projected_holders ${sql({
      fact_id: 'r-1',
      generation,
      harness: 'claude-code',
      parser_version: 1,
      source: 'claude-code',
      system,
    })}
  `;
  await sql`
    INSERT INTO stored_session_stretches ${sql({
      ...session,
      candidates: 1,
      ended_at: AT,
      link: 'linked',
      requests: 1,
      started_at: AT,
    })}
  `;
  await sql`
    INSERT INTO stored_session_totals ${sql({
      ...session,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      input_tokens: 1,
      output_tokens: 1,
      requests: 1,
      unpriced_requests: 1,
    })}
  `;
  await sql`
    INSERT INTO stored_session_model_totals ${sql({
      ...session,
      model: 'claude-opus-5-5',
      requests: 1,
      unpriced_requests: 1,
    })}
  `;
  // Its own Session: marking one rederiving forgets its stored rows.
  const rederiving = { ...session, session_id: 's-2' };
  await sql`INSERT INTO rederiving_sessions ${sql(rederiving)}`;
  await sql`INSERT INTO stale_sessions ${sql({ ...rederiving, stretches: true, totals: true })}`;
};

// A migrated database holding everything for old-1, which is unpaired, and
// laptop-1, which is paired, and the Hub's configuration file for it.
const setup = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  await seedSystem(db.sql, 'old-1', 1001);
  await seedSystem(db.sql, 'laptop-1', 2002);
  await storeToken(db.sql, { pairedAt: AT.getTime(), system: 'laptop-1', token: 'laptop-token' });
  const config = await hubConfig(db);
  return {
    args: configArgs(config),
    db,
    [Symbol.asyncDispose]: async () => {
      await config[Symbol.asyncDispose]();
      await db[Symbol.asyncDispose]();
    },
  };
};

test('the seed fills every table that holds a System', async () => {
  await using s = await setup();

  const counts = await countRows(s.db.sql, 'old-1');

  const empty = [...counts].filter(([, { all, named }]) => all === 0 || named === 0);
  expect(empty).toEqual([]);
});

test('purge system --transcripts leaves no row of the System, and every other System its own', async () => {
  await using s = await setup();
  const before = await countRows(s.db.sql, 'laptop-1');

  const { code, stdout } = await invoke(['purge', 'system', 'old-1', '--transcripts', ...s.args]);

  expect(stdout).toBe('Purged old-1 and 1 generation of its transcripts, 1 gzipped byte.\n');
  expect(code).toBe(0);
  const gone = await countRows(s.db.sql, 'old-1');
  const left = await countRows(s.db.sql, 'laptop-1');
  for (const [table, { all, named }] of before) {
    // Both Systems hold the same rows, so laptop-1's are half of each table.
    expect({ all: left.get(table)?.all, table }).toEqual({ all: all / 2, table });
    expect({ named: left.get(table)?.named, table }).toEqual({ named, table });
    if (named !== null) {
      expect({ named: gone.get(table)?.named, table }).toEqual({ named: 0, table });
    }
  }
});

test('purge system keeps the transcripts and their Session insight, and deletes the rest', async () => {
  await using s = await setup();
  const before = await countRows(s.db.sql, 'old-1');

  const { code, stdout } = await invoke(['purge', 'system', 'old-1', ...s.args]);

  expect(stdout).toBe(
    'Purged old-1. Its transcripts stay; add --transcripts to delete them too.\n',
  );
  expect(code).toBe(0);
  const after = await countRows(s.db.sql, 'old-1');
  for (const [table, { all, named }] of before) {
    // Deleting its Harness processes and Vitals marks its stretches stale, to recompute.
    if (table === 'stale_ranges') {
      expect(after.get(table)?.named).toBeGreaterThan(0);
    } else if (TRANSCRIPT_TABLES.has(table)) {
      expect({ all: after.get(table)?.all, table }).toEqual({ all, table });
    } else if (named === null) {
      expect({ all: after.get(table)?.all, table }).toEqual({ all: all / 2, table });
    } else {
      expect({ named: after.get(table)?.named, table }).toEqual({ named: 0, table });
    }
  }
});

test('purge system --transcripts after a purge that kept them deletes them', async () => {
  await using s = await setup();
  await invoke(['purge', 'system', 'old-1', ...s.args]);

  const { code, stdout } = await invoke(['purge', 'system', 'old-1', '--transcripts', ...s.args]);

  expect(stdout).toBe('Purged old-1 and 1 generation of its transcripts, 1 gzipped byte.\n');
  expect(code).toBe(0);
  const after = await countRows(s.db.sql, 'old-1');
  expect([...after].filter(([, { named }]) => named !== null && named > 0)).toEqual([]);
});

test('purge system without --transcripts, when only transcripts are left, says to add it and exits 1', async () => {
  await using s = await setup();
  await invoke(['purge', 'system', 'old-1', ...s.args]);

  const { code, stderr } = await invoke(['purge', 'system', 'old-1', ...s.args]);

  expect(stderr).toContain(
    'The Hub holds only transcripts for old-1. Add --transcripts to delete them.',
  );
  expect(code).toBe(1);
});

test('purge system refuses a paired System, deletes nothing, and exits 1', async () => {
  await using s = await setup();
  const before = await countRows(s.db.sql, 'laptop-1');

  const { code, stderr } = await invoke([
    'purge',
    'system',
    'laptop-1',
    '--transcripts',
    ...s.args,
  ]);

  expect(stderr).toContain('laptop-1 is paired. Run heimdall-hub unpair laptop-1 first.');
  expect(code).toBe(1);
  expect(await countRows(s.db.sql, 'laptop-1')).toEqual(before);
});

test('purge system refuses a System with a pending Pairing code, deletes nothing, and exits 1', async () => {
  await using s = await setup();
  await issueCode(s.db.sql, { now: Date.now(), system: 'old-1' });
  const before = await countRows(s.db.sql, 'old-1');

  const { code, stderr } = await invoke(['purge', 'system', 'old-1', ...s.args]);

  expect(stderr).toContain(
    'old-1 has a pending Pairing code. Run heimdall-hub unpair old-1 to withdraw it first.',
  );
  expect(code).toBe(1);
  expect(await countRows(s.db.sql, 'old-1')).toEqual(before);
});

test('purge system on a name the Hub holds nothing for says so and exits 1', async () => {
  await using s = await setup();

  const { code, stderr } = await invoke([
    'purge',
    'system',
    'laptop-2',
    '--transcripts',
    ...s.args,
  ]);

  expect(stderr).toContain('The Hub holds nothing for laptop-2.');
  expect(code).toBe(1);
});

test('a Session purge system keeps no longer links to the Harness process it deleted', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('old-1', now())`;
  const { addProcess, addSession } = timeline(AT.getTime());
  await addProcess(db.sql, { end: 600, pid: 100, start: 0, system: 'old-1' });
  await addSession(db.sql, { id: 's1', requests: [3, 200, 590], system: 'old-1' });
  await using config = await hubConfig(db);

  await invoke(['purge', 'system', 'old-1', ...configArgs(config)]);
  await refreshSessionInsight(db.sql);

  const stretches: unknown[] = await db.sql`
    SELECT session_id, link, pid FROM insight.session_stretches WHERE system = 'old-1'
  `;
  expect(stretches).toEqual([{ link: 'unmatched', pid: null, session_id: 's1' }]);
});
