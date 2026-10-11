import type { SQL } from 'bun';

// One schema change. Versions strictly increase, and an applied migration is
// never edited: a later change is a new migration. `serve` runs migrations
// under a 30-second statement timeout; a longer one raises it with SET LOCAL.
export type Migration = { sql: string; version: number };

export const MIGRATIONS: readonly Migration[] = [
  {
    // Each System the Hub has heard from, and the time it last did (glossary: Last
    // seen). Migration 10 also lets a paired System it never heard from have a row.
    // Samples keep their Vitals in columns and their disks as JSON, keyed by
    // System and time so a resent sample is skipped (ADR-0004).
    sql: `
      CREATE TABLE systems (
        name text PRIMARY KEY,
        last_seen_at timestamptz NOT NULL,
        collector_version text NOT NULL,
        collector_platform text NOT NULL,
        collector_arch text NOT NULL
      );

      CREATE TABLE vitals_samples (
        system text NOT NULL REFERENCES systems (name),
        t timestamptz NOT NULL,
        cpu_busy_percent double precision NOT NULL,
        memory_total_bytes bigint NOT NULL,
        memory_used_bytes bigint NOT NULL,
        load_1 double precision NOT NULL,
        load_5 double precision NOT NULL,
        load_15 double precision NOT NULL,
        uptime_seconds double precision NOT NULL,
        disks jsonb NOT NULL,
        collector_cpu_percent double precision NOT NULL,
        collector_rss_bytes bigint NOT NULL,
        PRIMARY KEY (system, t)
      );
    `,
    version: 1,
  },
  {
    // A System may be seen before any Report from it is stored, through a
    // rejected one, so its Collector build can be unknown (ADR-0005). Each
    // Condition is raised once and cleared once. A System holds at most one open
    // Condition of each kind and subject, so M4 can hold one per Service or
    // job; a Condition about the System itself has an empty subject.
    // The Timeline is read from these rows.
    sql: `
      ALTER TABLE systems
        ALTER COLUMN collector_version DROP NOT NULL,
        ALTER COLUMN collector_platform DROP NOT NULL,
        ALTER COLUMN collector_arch DROP NOT NULL;

      CREATE TABLE conditions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        system text NOT NULL REFERENCES systems (name),
        kind text NOT NULL,
        subject text NOT NULL DEFAULT '',
        raised_at timestamptz NOT NULL,
        raised_reason text NOT NULL,
        latest_at timestamptz NOT NULL,
        latest_reason text NOT NULL,
        cleared_at timestamptz
      );

      CREATE UNIQUE INDEX conditions_open ON conditions (system, kind, subject) WHERE cleared_at IS NULL;
      CREATE INDEX conditions_by_system ON conditions (system, raised_at DESC);
    `,
    version: 2,
  },
  {
    // Vitals roll up into 5-minute buckets, aligned to UTC, as samples arrive,
    // so raw samples can be pruned (ADR-0008). A bucket keeps the count, min,
    // sum, and max of each rolled-up Vital; average is sum over count. Byte
    // sums are numeric: a bucket may hold a sample per millisecond, which
    // could overflow bigint. The smallest uptime marks a reboot in the bucket.
    // Disks roll up per mount. The rollups are backfilled from the samples
    // already stored, which can outlast the usual statement timeout.
    sql: `
      SET LOCAL statement_timeout = '10min';

      CREATE TABLE vitals_rollups (
        system text NOT NULL REFERENCES systems (name),
        bucket timestamptz NOT NULL,
        samples integer NOT NULL,
        cpu_busy_min double precision NOT NULL,
        cpu_busy_sum double precision NOT NULL,
        cpu_busy_max double precision NOT NULL,
        memory_used_min bigint NOT NULL,
        memory_used_sum numeric NOT NULL,
        memory_used_max bigint NOT NULL,
        memory_total_max bigint NOT NULL,
        load_1_min double precision NOT NULL,
        load_1_sum double precision NOT NULL,
        load_1_max double precision NOT NULL,
        uptime_min double precision NOT NULL,
        collector_cpu_sum double precision NOT NULL,
        collector_cpu_max double precision NOT NULL,
        collector_rss_sum numeric NOT NULL,
        collector_rss_max bigint NOT NULL,
        PRIMARY KEY (system, bucket)
      );

      CREATE TABLE disk_rollups (
        system text NOT NULL REFERENCES systems (name),
        bucket timestamptz NOT NULL,
        mount text NOT NULL,
        used_max bigint NOT NULL,
        total_max bigint NOT NULL,
        PRIMARY KEY (system, bucket, mount)
      );

      INSERT INTO vitals_rollups
      SELECT
        system,
        date_bin('5 minutes', t, timestamptz '2000-01-01 00:00:00+00'),
        count(*),
        min(cpu_busy_percent), sum(cpu_busy_percent), max(cpu_busy_percent),
        min(memory_used_bytes), sum(memory_used_bytes), max(memory_used_bytes),
        max(memory_total_bytes),
        min(load_1), sum(load_1), max(load_1),
        min(uptime_seconds),
        sum(collector_cpu_percent), max(collector_cpu_percent),
        sum(collector_rss_bytes), max(collector_rss_bytes)
      FROM vitals_samples
      GROUP BY 1, 2;

      INSERT INTO disk_rollups
      SELECT
        system,
        date_bin('5 minutes', t, timestamptz '2000-01-01 00:00:00+00'),
        d->>'mount',
        max((d->>'usedBytes')::bigint),
        max((d->>'totalBytes')::bigint)
      FROM vitals_samples, jsonb_array_elements(disks) AS d
      GROUP BY 1, 2, 3;
    `,
    version: 3,
  },
  {
    // Each paired System's token, and the Pairing codes issued and not yet
    // redeemed, kept only as SHA-256 hashes (ADR-0009). A System may pair
    // before the Hub hears from it, so neither table refers to `systems`, and
    // unpairing leaves the System's history. A System has at most one token and
    // at most one pending code: issuing deletes its earlier code.
    sql: `
      CREATE TABLE paired_systems (
        system text PRIMARY KEY,
        token_hash bytea NOT NULL UNIQUE,
        paired_at timestamptz NOT NULL
      );

      CREATE TABLE pairing_codes (
        code_hash bytea PRIMARY KEY,
        system text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL
      );
    `,
    version: 4,
  },
  {
    // Transcripts as their Collectors uploaded them (ADR-0013). A generation
    // is one continuous run of a file's content; `held` counts the bytes of
    // the file it holds and `stored_bytes` the gzipped bytes of its chunks.
    // Each chunk is stored gzipped, as uploaded, at the file offset it starts
    // from; its content is a gzip stream, which may hold several members. A
    // path is indexed by its hash, since a long path outgrows an index entry.
    // A deleted generation keeps its row without its chunks, so the Hub
    // refuses its later chunks, and a path whose every generation is deleted
    // refuses new ones. Each System's latest set of sources and its spool
    // replace the earlier set; `sent_at` keeps an older Report from replacing
    // a newer one.
    sql: `
      CREATE TABLE transcript_generations (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        system text NOT NULL REFERENCES systems (name),
        source text NOT NULL,
        path text NOT NULL,
        held bigint NOT NULL DEFAULT 0,
        stored_bytes bigint NOT NULL DEFAULT 0,
        opened_at timestamptz NOT NULL,
        last_upload_at timestamptz NOT NULL,
        deleted_at timestamptz
      );

      CREATE INDEX transcript_generations_by_path
        ON transcript_generations (system, source, md5(path));
      CREATE INDEX transcript_generations_by_last_upload ON transcript_generations (last_upload_at);

      CREATE TABLE transcript_chunks (
        generation bigint NOT NULL REFERENCES transcript_generations (id),
        offset_bytes bigint NOT NULL,
        length bigint NOT NULL,
        content bytea NOT NULL,
        PRIMARY KEY (generation, offset_bytes)
      );

      CREATE TABLE transcript_sources (
        system text PRIMARY KEY REFERENCES systems (name),
        sources jsonb NOT NULL,
        spool_bytes bigint NOT NULL,
        spool_oldest_at timestamptz,
        sent_at timestamptz NOT NULL
      );
    `,
    version: 5,
  },
  {
    // Generation ids are random from here on (ADR-0013): a sequence goes
    // back with a restored backup and would reissue ids Collectors still hold.
    sql: 'ALTER TABLE transcript_generations ALTER COLUMN id DROP IDENTITY',
    version: 6,
  },
  {
    // Each System's mirror of the records its Collector holds (ADR-0011).
    // `record_sets` holds the latest set a Report carried: when it was sent
    // and received, the rows the Collector could not read, and, for a set too
    // large to send, its size with no records. `mirrored_records` holds the
    // readable records, each as the provisioner recorded it. A System with no
    // `record_sets` row has never sent a set. `sent_at` keeps an older Report
    // from replacing a newer set.
    sql: `
      CREATE TABLE record_sets (
        system text PRIMARY KEY REFERENCES systems (name),
        sent_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL,
        unreadable jsonb NOT NULL DEFAULT '[]',
        over_budget_bytes bigint
      );

      CREATE TABLE mirrored_records (
        system text NOT NULL REFERENCES systems (name),
        kind text NOT NULL,
        name text NOT NULL,
        record jsonb NOT NULL,
        PRIMARY KEY (system, kind, name)
      );
    `,
    version: 7,
  },
  {
    // Each System's time zone and the latest runs of its jobs. `time_zone` is
    // the IANA name its Collector last reported, null until one does. `run_sets`
    // holds the latest runs a Report carried the way `record_sets` holds a set
    // of records: when they were sent and received, the jobs the Collector or
    // the Hub could not read, and, for runs too large to send, their size with
    // no jobs. `mirrored_runs` holds each readable job's latest run and its
    // latest success, null for a job that has not succeeded. A System with no
    // `run_sets` row has never sent runs. `sent_at` keeps an older Report from
    // replacing newer runs.
    sql: `
      ALTER TABLE systems ADD COLUMN time_zone text;

      CREATE TABLE run_sets (
        system text PRIMARY KEY REFERENCES systems (name),
        sent_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL,
        unreadable jsonb NOT NULL DEFAULT '[]',
        over_budget_bytes bigint
      );

      CREATE TABLE mirrored_runs (
        system text NOT NULL REFERENCES systems (name),
        job text NOT NULL,
        latest_run jsonb NOT NULL,
        latest_success jsonb,
        PRIMARY KEY (system, job)
      );
    `,
    version: 8,
  },
  {
    // When the Hub first mirrored each record. A job's scheduled times count
    // only from then, so a job recorded today is not overdue for a time that
    // passed before. A row outlasts a set over budget or one that lists the
    // record as unreadable, since the record is still on the System, and goes
    // only when a set leaves the record out. Records mirrored before this
    // migration count from it.
    sql: `
      CREATE TABLE records_first_mirrored (
        system text NOT NULL REFERENCES systems (name),
        kind text NOT NULL,
        name text NOT NULL,
        first_mirrored_at timestamptz NOT NULL,
        PRIMARY KEY (system, kind, name)
      );

      INSERT INTO records_first_mirrored (system, kind, name, first_mirrored_at)
      SELECT system, kind, name, now() FROM mirrored_records;
    `,
    version: 9,
  },
  {
    // Whether a System sleeps, as its Collector says in every Report. Null until
    // a Report says, which counts as always on. A paired System the Hub has
    // never heard from can have a row, so that a Condition can be about it; its
    // last seen is null.
    sql: `
      ALTER TABLE systems ADD COLUMN sleeps boolean;
      ALTER TABLE systems ALTER COLUMN last_seen_at DROP NOT NULL;
    `,
    version: 10,
  },
  {
    // Each System's latest checks: what its Collector observed against its
    // records. `check_sets` holds the latest checks a Report carried the way
    // `record_sets` holds a set of records: when they were sent and received
    // and, for checks too large to send, their size with no files. `files`
    // lists the recorded files that did not match, each with its record, path,
    // state, and the epoch milliseconds the Collector first saw that state.
    // `file_records` lists the files records the Collector hashed, each with the
    // digest of the record it read. A System with no `check_sets` row has never
    // sent checks. `sent_at` keeps an older Report from replacing newer checks.
    sql: `
      CREATE TABLE check_sets (
        system text PRIMARY KEY REFERENCES systems (name),
        sent_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL,
        over_budget_bytes bigint,
        files jsonb NOT NULL DEFAULT '[]',
        file_records jsonb NOT NULL DEFAULT '[]'
      );
    `,
    version: 11,
  },
  {
    // Checks arrive in parts, and a part over budget no longer hides the
    // others, so `check_sets` keeps the size of each part that was too large to
    // send: the files part's in `files_over_budget_bytes`, which was
    // `over_budget_bytes` when it covered the whole section, and the services
    // part's in `services_over_budget_bytes`. `services` lists each check of
    // each recorded Service: its service, check, state, detail, and the epoch
    // milliseconds the Collector first saw that state. It is null when the
    // section carried no services part, which is not the same as an empty list:
    // a Collector without Service checks says nothing about any Service.
    // `files` and `file_records` are null when the section carried no files
    // part, which says the Collector has not finished a file pass yet and is
    // not the same as a files part that lists nothing, or when the files part
    // was too large to send. Checks stored before keep their lists.
    sql: `
      ALTER TABLE check_sets RENAME COLUMN over_budget_bytes TO files_over_budget_bytes;
      ALTER TABLE check_sets ADD COLUMN services jsonb;
      ALTER TABLE check_sets ADD COLUMN services_over_budget_bytes bigint;
      ALTER TABLE check_sets ALTER COLUMN files DROP NOT NULL;
      ALTER TABLE check_sets ALTER COLUMN files DROP DEFAULT;
      ALTER TABLE check_sets ALTER COLUMN file_records DROP NOT NULL;
      ALTER TABLE check_sets ALTER COLUMN file_records DROP DEFAULT;
    `,
    version: 12,
  },
  {
    // Each System's latest Harness installs, from the harnesses section of
    // its Reports. `installs` is the list as sent, each with its Harness,
    // location kind, and version. An empty list is a System with no Harness
    // installed; no row is a System that never sent the section. `sent_at`
    // keeps an older Report from replacing a newer list.
    sql: `
      CREATE TABLE harness_installs (
        system text PRIMARY KEY REFERENCES systems (name),
        installs jsonb NOT NULL,
        sent_at timestamptz NOT NULL
      );
    `,
    version: 13,
  },
  {
    // The Harness root processes each System's Collector saw (ADR-0014): one
    // row per process, identified by Harness, pid, and start, since a pid is
    // reused. A running process has no `ended_at`. One whose end the Collector
    // did not see has `end_missed` and ends at the last time it was seen. The
    // highest memory the Collector saw is kept on the row. `sent_at` is the
    // Report that last touched the row, so an older Report does not undo a
    // newer one. The index serves the join to Sessions by System, Harness, and
    // time. Process rows are kept.
    //
    // Each reading of a process's tree, cumulative CPU time and resident memory
    // at a time, is a sample on the Vitals time axis, and rolls up into a
    // 5-minute bucket as it arrives, as Vitals do (ADR-0008): CPU used in a
    // bucket is its max less its min, or less the bucket before's max. Samples
    // and rollups are pruned as Vitals are.
    sql: `
      CREATE TABLE harness_processes (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        system text NOT NULL REFERENCES systems (name),
        harness text NOT NULL,
        pid integer NOT NULL,
        started_at timestamptz NOT NULL,
        ended_at timestamptz,
        end_missed boolean NOT NULL DEFAULT false,
        cwd text,
        peak_rss_bytes bigint NOT NULL,
        last_seen_at timestamptz NOT NULL,
        sent_at timestamptz NOT NULL
      );
      CREATE INDEX harness_processes_by_system_harness_start
        ON harness_processes (system, harness, started_at);

      CREATE TABLE harness_process_samples (
        process bigint NOT NULL REFERENCES harness_processes (id),
        t timestamptz NOT NULL,
        cpu_micros bigint NOT NULL,
        rss_bytes bigint NOT NULL,
        PRIMARY KEY (process, t)
      );
      CREATE INDEX harness_process_samples_by_t ON harness_process_samples (t);

      CREATE TABLE harness_process_rollups (
        process bigint NOT NULL REFERENCES harness_processes (id),
        bucket timestamptz NOT NULL,
        samples integer NOT NULL,
        cpu_micros_min bigint NOT NULL,
        cpu_micros_max bigint NOT NULL,
        rss_min bigint NOT NULL,
        rss_sum numeric NOT NULL,
        rss_max bigint NOT NULL,
        PRIMARY KEY (process, bucket)
      );
      CREATE INDEX harness_process_rollups_by_bucket ON harness_process_rollups (bucket);
    `,
    version: 14,
  },
  {
    // Session insight: a projection of the transcript archive, rebuilt from it
    // whenever a Harness's parser version changes (ADR-0014).
    //
    // `transcript_source_harnesses` remembers which Harness each System's
    // source runs, from the latest Report sent that names it, so a source
    // removed from a Collector's configuration keeps its Harness. It starts
    // from the sets the Hub holds, and a source no set names whose name is a
    // Harness's, the default name, runs that Harness.
    //
    // Every projected row carries its Harness and the parser version that
    // wrote it. `current_parsers` names each Harness's current version, the
    // one the views read; a Harness with no row has no complete set yet. A
    // rebuild writes the next version's rows beside the current ones, then
    // switches. `parse_progress` holds, per Harness, version, and generation,
    // the byte offset the next batch starts from, the generation's `held` when
    // it was last read, whether the next batch starts inside a line too long
    // to read, the lines it could not read, how many attempts in a row to
    // parse it failed, when and why it was recorded failed, and the Session
    // the file belongs to, null for a file that holds no conversation. Facts
    // are keyed by the Harness's own ids within a System's source, so content
    // two generations hold counts once, and `projected_holders` names the
    // generations that held a fact more than one generation holds.
    // `rederiving_sessions` names the Sessions a delete touched, hidden from
    // the views until they are derived again. Requests and tool calls locate
    // the line they were read from by generation and byte offset in its
    // uncompressed content.
    //
    // The `insight` views are the read model: facts and locators, never
    // transcript content, and only each Harness's current version.
    sql: `
      CREATE TABLE transcript_source_harnesses (
        system text NOT NULL REFERENCES systems (name),
        source text NOT NULL,
        harness text NOT NULL,
        sent_at timestamptz NOT NULL,
        PRIMARY KEY (system, source)
      );

      INSERT INTO transcript_source_harnesses (system, source, harness, sent_at)
      SELECT system, s->>'name', s->>'harness', sent_at
      FROM transcript_sources, jsonb_array_elements(sources) AS s
      ON CONFLICT DO NOTHING;

      INSERT INTO transcript_source_harnesses (system, source, harness, sent_at)
      SELECT DISTINCT system, source, source, '-infinity'::timestamptz FROM transcript_generations
      WHERE source IN ('claude-code', 'codex')
      ON CONFLICT DO NOTHING;

      CREATE TABLE current_parsers (
        harness text PRIMARY KEY,
        version integer NOT NULL
      );

      CREATE TABLE parse_progress (
        harness text NOT NULL,
        parser_version integer NOT NULL,
        generation bigint NOT NULL REFERENCES transcript_generations (id),
        session_id text,
        parsed_through bigint NOT NULL,
        held_seen bigint NOT NULL,
        skipping_line boolean NOT NULL DEFAULT false,
        unreadable_lines bigint NOT NULL DEFAULT 0,
        failed_attempts integer NOT NULL DEFAULT 0,
        failed_at timestamptz,
        failure text,
        PRIMARY KEY (harness, parser_version, generation)
      );

      CREATE INDEX parse_progress_by_generation ON parse_progress (generation);
      CREATE INDEX parse_progress_by_session ON parse_progress (harness, session_id);

      CREATE TABLE projected_sessions (
        harness text NOT NULL,
        parser_version integer NOT NULL,
        system text NOT NULL,
        source text NOT NULL,
        session_id text NOT NULL,
        path text,
        started_at timestamptz,
        ended_at timestamptz,
        first_cwd text,
        last_cwd text,
        first_git_branch text,
        last_git_branch text,
        first_harness_version text,
        last_harness_version text,
        PRIMARY KEY (harness, parser_version, system, source, session_id)
      );

      CREATE INDEX projected_sessions_by_session
        ON projected_sessions (harness, system, source, session_id);

      CREATE TABLE projected_subagents (
        harness text NOT NULL,
        parser_version integer NOT NULL,
        system text NOT NULL,
        source text NOT NULL,
        session_id text NOT NULL,
        agent_id text NOT NULL,
        path text,
        agent_type text,
        depth integer,
        parent_agent_id text,
        tool_use_id text,
        workflow_run text,
        workflow_phase text,
        started_at timestamptz,
        ended_at timestamptz,
        PRIMARY KEY (harness, parser_version, system, source, session_id, agent_id)
      );

      CREATE INDEX projected_subagents_by_session
        ON projected_subagents (harness, system, source, session_id);

      CREATE TABLE projected_requests (
        harness text NOT NULL,
        parser_version integer NOT NULL,
        system text NOT NULL,
        source text NOT NULL,
        session_id text NOT NULL,
        agent_id text,
        request_id text NOT NULL,
        at timestamptz NOT NULL,
        model text NOT NULL,
        input_tokens bigint NOT NULL,
        output_tokens bigint NOT NULL,
        reasoning_tokens bigint,
        cache_read_tokens bigint NOT NULL,
        cache_write_tokens bigint NOT NULL,
        cache_write_5m_tokens bigint,
        cache_write_1h_tokens bigint,
        stop_reason text,
        skill text,
        generation bigint NOT NULL,
        byte_offset bigint NOT NULL,
        PRIMARY KEY (harness, parser_version, system, source, request_id)
      );

      CREATE INDEX projected_requests_by_session
        ON projected_requests (harness, system, source, session_id);

      CREATE TABLE projected_tool_calls (
        harness text NOT NULL,
        parser_version integer NOT NULL,
        system text NOT NULL,
        source text NOT NULL,
        session_id text NOT NULL,
        agent_id text,
        call_id text NOT NULL,
        request_id text,
        at timestamptz NOT NULL,
        kind text NOT NULL,
        name text NOT NULL,
        mcp_server text,
        skill text,
        generation bigint NOT NULL,
        byte_offset bigint NOT NULL,
        PRIMARY KEY (harness, parser_version, system, source, call_id)
      );

      CREATE INDEX projected_tool_calls_by_session
        ON projected_tool_calls (harness, system, source, session_id);

      CREATE TABLE projected_holders (
        harness text NOT NULL,
        parser_version integer NOT NULL,
        system text NOT NULL,
        source text NOT NULL,
        fact_id text NOT NULL,
        generation bigint NOT NULL REFERENCES transcript_generations (id),
        PRIMARY KEY (harness, parser_version, system, source, fact_id, generation)
      );

      CREATE INDEX projected_holders_by_generation ON projected_holders (generation);

      CREATE TABLE rederiving_sessions (
        harness text NOT NULL,
        system text NOT NULL,
        source text NOT NULL,
        session_id text NOT NULL,
        PRIMARY KEY (harness, system, source, session_id)
      );

      CREATE SCHEMA insight;

      CREATE VIEW insight.sessions AS
      SELECT s.harness, s.system, s.source, s.session_id, s.path, s.started_at, s.ended_at,
             s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch,
             s.first_harness_version, s.last_harness_version, s.parser_version
      FROM projected_sessions s
      JOIN current_parsers c ON c.harness = s.harness AND c.version = s.parser_version
      WHERE NOT EXISTS (
        SELECT 1 FROM rederiving_sessions x
        WHERE x.harness = s.harness AND x.system = s.system AND x.source = s.source
          AND x.session_id = s.session_id
      );

      CREATE VIEW insight.subagents AS
      SELECT a.harness, a.system, a.source, a.session_id, a.agent_id,
             COALESCE(a.parent_agent_id, spawn.agent_id) AS parent_agent_id,
             a.agent_type, a.depth, a.tool_use_id, a.workflow_run, a.workflow_phase,
             a.path, a.started_at, a.ended_at, a.parser_version
      FROM projected_subagents a
      JOIN current_parsers c ON c.harness = a.harness AND c.version = a.parser_version
      LEFT JOIN projected_tool_calls spawn
        ON spawn.harness = a.harness AND spawn.parser_version = a.parser_version
       AND spawn.system = a.system AND spawn.source = a.source AND spawn.call_id = a.tool_use_id
      WHERE NOT EXISTS (
        SELECT 1 FROM rederiving_sessions x
        WHERE x.harness = a.harness AND x.system = a.system AND x.source = a.source
          AND x.session_id = a.session_id
      );

      CREATE VIEW insight.requests AS
      SELECT r.harness, r.system, r.source, r.session_id, r.agent_id, r.request_id, r.at, r.model,
             r.input_tokens, r.output_tokens, r.reasoning_tokens, r.cache_read_tokens,
             r.cache_write_tokens, r.cache_write_5m_tokens, r.cache_write_1h_tokens,
             r.input_tokens + r.cache_read_tokens + r.cache_write_tokens AS context_tokens,
             r.stop_reason, r.skill, g.path, r.generation, r.byte_offset, r.parser_version
      FROM projected_requests r
      JOIN current_parsers c ON c.harness = r.harness AND c.version = r.parser_version
      JOIN transcript_generations g ON g.id = r.generation
      WHERE NOT EXISTS (
        SELECT 1 FROM rederiving_sessions x
        WHERE x.harness = r.harness AND x.system = r.system AND x.source = r.source
          AND x.session_id = r.session_id
      );

      CREATE VIEW insight.tool_calls AS
      SELECT t.harness, t.system, t.source, t.session_id, t.agent_id, t.request_id, t.call_id,
             t.at, t.kind, t.name, t.mcp_server, t.skill, g.path, t.generation, t.byte_offset,
             t.parser_version
      FROM projected_tool_calls t
      JOIN current_parsers c ON c.harness = t.harness AND c.version = t.parser_version
      JOIN transcript_generations g ON g.id = t.generation
      WHERE NOT EXISTS (
        SELECT 1 FROM rederiving_sessions x
        WHERE x.harness = t.harness AND x.system = t.system AND x.source = t.source
          AND x.session_id = t.session_id
      );

      -- Per-request counts are bounded at parse time, so a bigint sum cannot
      -- overflow. A count no request recorded sums to null.
      CREATE VIEW insight.session_totals AS
      SELECT s.harness, s.system, s.source, s.session_id,
             count(r.request_id)::bigint AS requests,
             COALESCE(sum(r.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(sum(r.output_tokens), 0)::bigint AS output_tokens,
             sum(r.reasoning_tokens)::bigint AS reasoning_tokens,
             COALESCE(sum(r.cache_read_tokens), 0)::bigint AS cache_read_tokens,
             COALESCE(sum(r.cache_write_tokens), 0)::bigint AS cache_write_tokens,
             sum(r.cache_write_5m_tokens)::bigint AS cache_write_5m_tokens,
             sum(r.cache_write_1h_tokens)::bigint AS cache_write_1h_tokens
      FROM insight.sessions s
      LEFT JOIN insight.requests r
        ON r.harness = s.harness AND r.system = s.system AND r.source = s.source
       AND r.session_id = s.session_id
      GROUP BY s.harness, s.system, s.source, s.session_id;

      CREATE VIEW insight.main_conversation_totals AS
      SELECT s.harness, s.system, s.source, s.session_id,
             count(r.request_id)::bigint AS requests,
             COALESCE(sum(r.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(sum(r.output_tokens), 0)::bigint AS output_tokens,
             sum(r.reasoning_tokens)::bigint AS reasoning_tokens,
             COALESCE(sum(r.cache_read_tokens), 0)::bigint AS cache_read_tokens,
             COALESCE(sum(r.cache_write_tokens), 0)::bigint AS cache_write_tokens,
             sum(r.cache_write_5m_tokens)::bigint AS cache_write_5m_tokens,
             sum(r.cache_write_1h_tokens)::bigint AS cache_write_1h_tokens
      FROM insight.sessions s
      LEFT JOIN insight.requests r
        ON r.harness = s.harness AND r.system = s.system AND r.source = s.source
       AND r.session_id = s.session_id AND r.agent_id IS NULL
      GROUP BY s.harness, s.system, s.source, s.session_id;

      -- How well the current version read each source: counts only, never
      -- what a line or a failure said.
      CREATE VIEW insight.parse_status AS
      SELECT p.harness, g.system, g.source, p.parser_version,
             count(*)::bigint AS generations,
             count(p.failed_at)::bigint AS failed_generations,
             sum(p.unreadable_lines)::bigint AS unreadable_lines
      FROM parse_progress p
      JOIN current_parsers c ON c.harness = p.harness AND c.version = p.parser_version
      JOIN transcript_generations g ON g.id = p.generation
      WHERE g.deleted_at IS NULL
      GROUP BY p.harness, g.system, g.source, p.parser_version;
    `,
    version: 15,
  },
];

// Serializes Hubs that start against the same database at once. The name is
// arbitrary; it only has to be the same for every Hub.
const MIGRATION_LOCK = 'heimdall-migrations';

// How long a migration waits for a lock another session holds before it gives
// up with lock_not_available (SQLSTATE 55P03). The statement timeout would
// otherwise end the wait after 30 seconds with a message that names no lock.
// `migrateWhenFree` retries after it.
export const MIGRATION_LOCK_TIMEOUT_MS = 5000;

// Brings the database to the latest version in one transaction and answers the
// versions it applied, oldest first. A lock held by another session, such as a
// backup's, fails the run with lock_not_available after `lockTimeoutMs`;
// the advisory lock that serializes Hubs counts too. Tests pass `migrations` to
// stop at an earlier version, or to add a pending one.
export const migrate = (
  sql: SQL,
  migrations = MIGRATIONS,
  { lockTimeoutMs = MIGRATION_LOCK_TIMEOUT_MS }: { lockTimeoutMs?: number } = {},
): Promise<number[]> =>
  sql.begin(async (tx) => {
    await tx`SELECT set_config('lock_timeout', ${`${String(lockTimeoutMs)}ms`}, true)`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const rows: { version: number }[] = await tx`SELECT version FROM schema_migrations`;
    const done = new Set(rows.map((row) => row.version));
    const applied: number[] = [];
    for (const migration of migrations) {
      if (done.has(migration.version)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- migrations apply in order.
      await tx.unsafe(migration.sql);
      // oxlint-disable-next-line no-await-in-loop -- recorded with the migration it follows.
      await tx`INSERT INTO schema_migrations (version) VALUES (${migration.version})`;
      applied.push(migration.version);
    }
    return applied;
  });
