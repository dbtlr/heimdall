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
    // to read, the lines it could not read, whether its path names its owner
    // by a name shaped as no id, how many attempts in a row to parse it failed, when and why it was recorded failed, and the Session
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
        misnamed boolean NOT NULL DEFAULT false,
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
             sum(p.unreadable_lines)::bigint AS unreadable_lines,
             count(*) FILTER (WHERE p.misnamed)::bigint AS misnamed_files
      FROM parse_progress p
      JOIN current_parsers c ON c.harness = p.harness AND c.version = p.parser_version
      JOIN transcript_generations g ON g.id = p.generation
      WHERE g.deleted_at IS NULL
      GROUP BY p.harness, g.system, g.source, p.parser_version;
    `,
    version: 15,
  },
  {
    // List-price cost and context fill, computed when read and never stored
    // (ADR-0014). `model_prices` holds the Hub's price table, loaded by
    // `serve` from the bundled prices and the configured ones (prices.ts,
    // price-table.ts): one row per model, start day, prompt tier, and source,
    // in dollars per million tokens. A model that reprices the whole request
    // above a prompt size has a row per tier; `min_prompt_tokens` is the
    // smallest prompt, its input, cache read, and cache write tokens, a tier
    // applies to, and 0 for a model with one price. A request is priced, for
    // its model without a `-YYYYMMDD` suffix, by the row in force at its time
    // (`valid_from` on or before it) of the highest tier its prompt reaches,
    // then the latest `valid_from`, then a configured row before a bundled
    // one: so a dated row replaces only its own tier. A
    // request with no such row, or with tokens of a kind the row has no price
    // for, has a null cost; it is never free. A cache write the Harness did
    // not split is priced as a 5-minute write. A request's context window
    // comes from the row here; migration 18 prefers one the Harness recorded.
    sql: `
      CREATE TABLE model_prices (
        model text NOT NULL,
        valid_from timestamptz NOT NULL,
        source text NOT NULL CHECK (source IN ('bundled', 'configured')),
        input_per_mtok numeric NOT NULL CHECK (input_per_mtok >= 0),
        output_per_mtok numeric NOT NULL CHECK (output_per_mtok >= 0),
        cache_read_per_mtok numeric CHECK (cache_read_per_mtok >= 0),
        cache_write_5m_per_mtok numeric CHECK (cache_write_5m_per_mtok >= 0),
        cache_write_1h_per_mtok numeric CHECK (cache_write_1h_per_mtok >= 0),
        context_window bigint NOT NULL CHECK (context_window > 0),
        min_prompt_tokens bigint NOT NULL DEFAULT 0 CHECK (min_prompt_tokens >= 0),
        PRIMARY KEY (model, valid_from, min_prompt_tokens, source)
      );

      -- Tokens at a price per million tokens. No tokens cost nothing even at no
      -- price; tokens at no price have no cost.
      CREATE FUNCTION price_tokens(tokens bigint, per_mtok numeric) RETURNS numeric
      LANGUAGE sql IMMUTABLE AS $$
        SELECT CASE WHEN tokens = 0 THEN 0 ELSE tokens * per_mtok / 1000000 END
      $$;

      CREATE OR REPLACE VIEW insight.requests AS
      SELECT r.harness, r.system, r.source, r.session_id, r.agent_id, r.request_id, r.at, r.model,
             r.input_tokens, r.output_tokens, r.reasoning_tokens, r.cache_read_tokens,
             r.cache_write_tokens, r.cache_write_5m_tokens, r.cache_write_1h_tokens,
             r.input_tokens + r.cache_read_tokens + r.cache_write_tokens AS context_tokens,
             r.stop_reason, r.skill, g.path, r.generation, r.byte_offset, r.parser_version,
             CASE WHEN price.model IS NULL THEN NULL ELSE
               price_tokens(r.input_tokens, price.input_per_mtok)
               + price_tokens(r.output_tokens, price.output_per_mtok)
               + price_tokens(r.cache_read_tokens, price.cache_read_per_mtok)
               + price_tokens(GREATEST(r.cache_write_tokens - COALESCE(r.cache_write_1h_tokens, 0), 0),
                              price.cache_write_5m_per_mtok)
               + price_tokens(COALESCE(r.cache_write_1h_tokens, 0), price.cache_write_1h_per_mtok)
             END AS cost_usd,
             price.context_window AS context_window,
             (r.input_tokens + r.cache_read_tokens + r.cache_write_tokens)::numeric * 100
               / price.context_window AS context_fill_percent
      FROM projected_requests r
      JOIN current_parsers c ON c.harness = r.harness AND c.version = r.parser_version
      JOIN transcript_generations g ON g.id = r.generation
      LEFT JOIN LATERAL (
        SELECT p.*
        FROM model_prices p
        WHERE p.model = regexp_replace(r.model, '-[0-9]{8}$', '') AND p.valid_from <= r.at
          AND p.min_prompt_tokens <= r.input_tokens + r.cache_read_tokens + r.cache_write_tokens
        ORDER BY p.min_prompt_tokens DESC, p.valid_from DESC, p.source = 'configured' DESC
        LIMIT 1
      ) price ON true
      WHERE NOT EXISTS (
        SELECT 1 FROM rederiving_sessions x
        WHERE x.harness = r.harness AND x.system = r.system AND x.source = r.source
          AND x.session_id = r.session_id
      );

      -- cost_usd is null when any request is unpriced, so a partial sum is never
      -- read as the total; priced_cost_usd is the sum over the priced requests,
      -- null when there are none.
      CREATE OR REPLACE VIEW insight.session_totals AS
      SELECT s.harness, s.system, s.source, s.session_id,
             count(r.request_id)::bigint AS requests,
             COALESCE(sum(r.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(sum(r.output_tokens), 0)::bigint AS output_tokens,
             sum(r.reasoning_tokens)::bigint AS reasoning_tokens,
             COALESCE(sum(r.cache_read_tokens), 0)::bigint AS cache_read_tokens,
             COALESCE(sum(r.cache_write_tokens), 0)::bigint AS cache_write_tokens,
             sum(r.cache_write_5m_tokens)::bigint AS cache_write_5m_tokens,
             sum(r.cache_write_1h_tokens)::bigint AS cache_write_1h_tokens,
             CASE WHEN count(r.request_id) FILTER (WHERE r.cost_usd IS NULL) = 0
                  THEN COALESCE(sum(r.cost_usd), 0) END AS cost_usd,
             sum(r.cost_usd) AS priced_cost_usd,
             (count(r.request_id) FILTER (WHERE r.cost_usd IS NULL))::bigint AS unpriced_requests
      FROM insight.sessions s
      LEFT JOIN insight.requests r
        ON r.harness = s.harness AND r.system = s.system AND r.source = s.source
       AND r.session_id = s.session_id
      GROUP BY s.harness, s.system, s.source, s.session_id;

      CREATE OR REPLACE VIEW insight.main_conversation_totals AS
      SELECT s.harness, s.system, s.source, s.session_id,
             count(r.request_id)::bigint AS requests,
             COALESCE(sum(r.input_tokens), 0)::bigint AS input_tokens,
             COALESCE(sum(r.output_tokens), 0)::bigint AS output_tokens,
             sum(r.reasoning_tokens)::bigint AS reasoning_tokens,
             COALESCE(sum(r.cache_read_tokens), 0)::bigint AS cache_read_tokens,
             COALESCE(sum(r.cache_write_tokens), 0)::bigint AS cache_write_tokens,
             sum(r.cache_write_5m_tokens)::bigint AS cache_write_5m_tokens,
             sum(r.cache_write_1h_tokens)::bigint AS cache_write_1h_tokens,
             CASE WHEN count(r.request_id) FILTER (WHERE r.cost_usd IS NULL) = 0
                  THEN COALESCE(sum(r.cost_usd), 0) END AS cost_usd,
             sum(r.cost_usd) AS priced_cost_usd,
             (count(r.request_id) FILTER (WHERE r.cost_usd IS NULL))::bigint AS unpriced_requests
      FROM insight.sessions s
      LEFT JOIN insight.requests r
        ON r.harness = s.harness AND r.system = s.system AND r.source = s.source
       AND r.session_id = s.session_id AND r.agent_id IS NULL
      GROUP BY s.harness, s.system, s.source, s.session_id;
    `,
    version: 16,
  },
  {
    // Every `insight` view is a security barrier, so the insight reader's own
    // filters run only on the rows a view shows. Without it, the planner can
    // run a reader's filter on a row the view hides, such as a Session a
    // delete is deriving again, a parser version that is not current, or a
    // deleted generation's path, and an error or a function the filter calls
    // shows that row's values. CREATE OR REPLACE VIEW resets a view's options,
    // so a later migration that creates or replaces an `insight` view writes
    // `WITH (security_barrier = true)` each time.
    sql: `
      ALTER VIEW insight.sessions SET (security_barrier = true);
      ALTER VIEW insight.subagents SET (security_barrier = true);
      ALTER VIEW insight.requests SET (security_barrier = true);
      ALTER VIEW insight.tool_calls SET (security_barrier = true);
      ALTER VIEW insight.session_totals SET (security_barrier = true);
      ALTER VIEW insight.main_conversation_totals SET (security_barrier = true);
      ALTER VIEW insight.parse_status SET (security_barrier = true);
    `,
    version: 17,
  },
  {
    // Codex resumes with header and turn facts from earlier batches. Skills
    // inferred from reads stay distinguishable from recorded invocations. A
    // context window the Harness recorded on a request takes precedence over
    // the price table's.
    sql: `
      ALTER TABLE parse_progress ADD COLUMN parser_state jsonb;
      ALTER TABLE parse_progress ADD COLUMN agent_id text;
      ALTER TABLE projected_subagents ADD COLUMN parent_thread_id text;
      CREATE UNIQUE INDEX projected_codex_subagents_by_thread
        ON projected_subagents (harness, parser_version, system, source, agent_id) WHERE harness = 'codex';
      CREATE INDEX projected_codex_subagents_to_link
        ON projected_subagents (parser_version) WHERE harness = 'codex' AND depth IS NULL;
      ALTER TABLE projected_requests ADD COLUMN context_window bigint;
      ALTER TABLE projected_tool_calls ADD COLUMN skill_inferred boolean NOT NULL DEFAULT false;

      CREATE OR REPLACE VIEW insight.requests WITH (security_barrier = true) AS
      SELECT r.harness, r.system, r.source, r.session_id, r.agent_id, r.request_id, r.at, r.model,
             r.input_tokens, r.output_tokens, r.reasoning_tokens, r.cache_read_tokens,
             r.cache_write_tokens, r.cache_write_5m_tokens, r.cache_write_1h_tokens,
             r.input_tokens + r.cache_read_tokens + r.cache_write_tokens AS context_tokens,
             r.stop_reason, r.skill, g.path, r.generation, r.byte_offset, r.parser_version,
             CASE WHEN price.model IS NULL THEN NULL ELSE
               price_tokens(r.input_tokens, price.input_per_mtok)
               + price_tokens(r.output_tokens, price.output_per_mtok)
               + price_tokens(r.cache_read_tokens, price.cache_read_per_mtok)
               + price_tokens(GREATEST(r.cache_write_tokens - COALESCE(r.cache_write_1h_tokens, 0), 0),
                              price.cache_write_5m_per_mtok)
               + price_tokens(COALESCE(r.cache_write_1h_tokens, 0), price.cache_write_1h_per_mtok)
             END AS cost_usd,
             COALESCE(r.context_window, price.context_window) AS context_window,
             (r.input_tokens + r.cache_read_tokens + r.cache_write_tokens)::numeric * 100
               / COALESCE(r.context_window, price.context_window) AS context_fill_percent
      FROM projected_requests r
      JOIN current_parsers c ON c.harness = r.harness AND c.version = r.parser_version
      JOIN transcript_generations g ON g.id = r.generation
      LEFT JOIN LATERAL (
        SELECT p.*
        FROM model_prices p
        WHERE p.model = regexp_replace(r.model, '-[0-9]{8}$', '') AND p.valid_from <= r.at
          AND p.min_prompt_tokens <= r.input_tokens + r.cache_read_tokens + r.cache_write_tokens
        ORDER BY p.min_prompt_tokens DESC, p.valid_from DESC, p.source = 'configured' DESC
        LIMIT 1
      ) price ON true
      WHERE NOT EXISTS (
        SELECT 1 FROM rederiving_sessions x
        WHERE x.harness = r.harness AND x.system = r.system AND x.source = r.source
          AND x.session_id = r.session_id
      );

      CREATE OR REPLACE VIEW insight.tool_calls WITH (security_barrier = true) AS
      SELECT t.harness, t.system, t.source, t.session_id, t.agent_id, t.request_id, t.call_id,
             t.at, t.kind, t.name, t.mcp_server, t.skill, g.path, t.generation, t.byte_offset,
             t.parser_version, t.skill_inferred
      FROM projected_tool_calls t
      JOIN current_parsers c ON c.harness = t.harness AND c.version = t.parser_version
      JOIN transcript_generations g ON g.id = t.generation
      WHERE NOT EXISTS (
        SELECT 1 FROM rederiving_sessions x
        WHERE x.harness = t.harness AND x.system = t.system AND x.source = t.source
          AND x.session_id = t.session_id
      );
    `,
    version: 18,
  },
  {
    // Links each stretch of a Session to the Harness process that ran it,
    // computed in views and never stored, so a link lives exactly as long as
    // its Session and its process and changes with nothing to rebuild
    // (ADR-0014). The spec's "Linking Harness processes to Sessions" states the
    // rule; this is how the views compute it.
    //
    // Every time compared is the observed System's own clock: transcript lines,
    // a process's start, end, and readings, and Vitals samples. The Hub's clock
    // stamps none of them.
    //
    // `harness_process_windows` holds each process's window. It opens 2
    // seconds before the start, which is to the second. A process surely ran
    // (`ran_until`) until its end, or while the Hub holds it as running, until
    // 60 seconds after its last sighting. It may have run (`may_until`) until
    // its seen end; after a missed end, until the end of the first 5-minute
    // Vitals bucket after the one holding the last sighting; and while it runs,
    // or with no Vitals since a missed end, without end.
    //
    // For each request, the processes that may have run its Session are those
    // of its System and Harness, in the Session's first or last directory or
    // an unknown one, whose windows overlap the Session's requests. The
    // request's candidates are those whose window holds it, and its stretch is
    // the Session's requests between the nearest window edges around it, so
    // the candidates stay the same across the stretch. The first and last
    // requests of a stretch are found by index, so each request costs a few
    // lookups however long its Session, and a query costs in proportion to
    // the time it reads, not to the history held.
    //
    // Indexes: each process's stored span, start to end or without end while
    // running, as a range, so the processes around a time are found by
    // overlap; each Session's request span as a range; and requests by System
    // and time, and by Session and time. A span never ends before it starts,
    // even after a clock step. A process whose end was missed may have run
    // past its stored span, but it can matter to a time only when no Vitals
    // bucket ended between its last sighting and that time, so the span lookup
    // reaches back to the latest such bucket. The range index holds no
    // System, which would take the btree_gist extension; it finds the
    // processes of every System around a time, which a fleet keeps few.
    //
    // A Session's request span, `first_request_at` to `last_request_at`, runs
    // from its first request to its last, its subagents' included, so it can
    // reach past its main transcript's span. A trigger widens it as requests
    // are stored, since no index can hold an aggregate. It never narrows: a
    // request moved to another Session or deleted can leave it wider than the
    // requests, which costs a lookup and changes no row, since the views
    // compare the requests themselves.
    //
    // Every insight view is a security barrier, so a reader's filter cannot
    // see rows a view hides through an error it raises.
    sql: `
      SET LOCAL statement_timeout = '10min';

      CREATE INDEX harness_processes_by_span ON harness_processes USING gist (
        tstzrange(started_at, CASE WHEN ended_at IS NULL THEN 'infinity'::timestamptz
                                   ELSE GREATEST(started_at, ended_at) END, '[]')
      );
      ALTER TABLE projected_sessions
        ADD COLUMN first_request_at timestamptz,
        ADD COLUMN last_request_at timestamptz;
      UPDATE projected_sessions s SET first_request_at = r.first_at, last_request_at = r.last_at
      FROM (
        SELECT harness, parser_version, system, source, session_id,
               min(at) AS first_at, max(at) AS last_at
        FROM projected_requests GROUP BY harness, parser_version, system, source, session_id
      ) r
      WHERE (s.harness, s.parser_version, s.system, s.source, s.session_id)
          = (r.harness, r.parser_version, r.system, r.source, r.session_id);

      CREATE FUNCTION widen_session_request_spans() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE projected_sessions s
        SET first_request_at = LEAST(s.first_request_at, r.first_at),
            last_request_at = GREATEST(s.last_request_at, r.last_at)
        FROM (
          SELECT harness, parser_version, system, source, session_id,
                 min(at) AS first_at, max(at) AS last_at
          FROM stored GROUP BY harness, parser_version, system, source, session_id
        ) r
        WHERE (s.harness, s.parser_version, s.system, s.source, s.session_id)
            = (r.harness, r.parser_version, r.system, r.source, r.session_id)
          AND (s.first_request_at IS NULL OR r.first_at < s.first_request_at
               OR r.last_at > s.last_request_at);
        RETURN NULL;
      END
      $$;
      CREATE TRIGGER widen_session_request_spans_on_insert AFTER INSERT ON projected_requests
        REFERENCING NEW TABLE AS stored
        FOR EACH STATEMENT EXECUTE FUNCTION widen_session_request_spans();
      CREATE TRIGGER widen_session_request_spans_on_update AFTER UPDATE ON projected_requests
        REFERENCING NEW TABLE AS stored
        FOR EACH STATEMENT EXECUTE FUNCTION widen_session_request_spans();

      CREATE INDEX projected_sessions_by_request_span ON projected_sessions USING gist (
        tstzrange(first_request_at, last_request_at, '[]')
      ) WHERE first_request_at IS NOT NULL;
      CREATE INDEX projected_requests_by_time ON projected_requests (system, at);
      CREATE INDEX projected_requests_by_session_time
        ON projected_requests (harness, system, source, session_id, at);

      CREATE VIEW harness_process_windows AS
      SELECT p.id, p.system, p.harness, p.pid, p.started_at, p.ended_at, p.end_missed, p.cwd,
             p.last_seen_at,
             tstzrange(p.started_at, CASE WHEN p.ended_at IS NULL THEN 'infinity'::timestamptz
                                          ELSE GREATEST(p.started_at, p.ended_at) END, '[]') AS span,
             p.started_at - interval '2 seconds' AS window_from,
             COALESCE(p.ended_at, p.last_seen_at + interval '60 seconds') AS ran_until,
             COALESCE(
               CASE WHEN NOT p.end_missed THEN p.ended_at ELSE (
                 SELECT min(v.bucket) + interval '5 minutes' FROM vitals_rollups v
                 WHERE v.system = p.system
                   AND v.bucket > date_bin('5 minutes', p.ended_at, timestamptz '2000-01-01 00:00:00+00')
               ) END,
               'infinity'
             ) AS may_until
      FROM harness_processes p;

      CREATE VIEW insight.harness_processes WITH (security_barrier = true) AS
      SELECT w.system, w.harness, w.id AS process_id, w.pid, w.started_at, w.ended_at,
             w.end_missed, w.cwd, p.peak_rss_bytes, w.last_seen_at,
             NULLIF(w.may_until, 'infinity') AS may_have_run_until
      FROM harness_process_windows w JOIN harness_processes p ON p.id = w.id;

      -- One row per request. \`procs\` holds the processes that may have run
      -- the Session at some time between its first and last request, once per
      -- Session; the span filter only narrows them to what the index finds,
      -- reaching back to the last Vitals bucket before the Session for missed
      -- ends, and the window conditions after it are the rule. \`near\` holds
      -- the request's candidates and the window edges around it, \`stretch\`
      -- the first and last request between those edges, and \`k\` the process
      -- the stretch is linked to. OFFSET 0 keeps a subquery from being inlined
      -- where its result is used more than once.
      CREATE VIEW insight.request_links WITH (security_barrier = true) AS
      SELECT r.harness, r.system, r.source, r.session_id, r.agent_id, r.request_id, r.at, r.model,
             CASE WHEN near.candidates > 1 THEN 'ambiguous'
                  WHEN k.process_id IS NOT NULL THEN 'linked'
                  ELSE 'unmatched' END AS link,
             k.process_id, k.pid, near.candidates,
             stretch.first_at AS stretch_started_at, stretch.last_at AS stretch_ended_at
      FROM insight.requests r
      CROSS JOIN LATERAL (
        SELECT x.first_cwd, x.last_cwd FROM insight.sessions x
        WHERE x.harness = r.harness AND x.system = r.system AND x.source = r.source
          AND x.session_id = r.session_id
        OFFSET 0
      ) s
      CROSS JOIN LATERAL (
        SELECT min(x.at) AS first_at, max(x.at) AS last_at FROM projected_requests x
        WHERE x.harness = r.harness AND x.system = r.system AND x.source = r.source
          AND x.session_id = r.session_id AND x.parser_version = r.parser_version
      ) requests
      CROSS JOIN LATERAL (
        SELECT array_agg(w.id) AS ids, array_agg(w.window_from) AS froms,
               array_agg(w.may_until) AS mays
        FROM harness_process_windows w
        WHERE w.span && tstzrange(
                COALESCE((
                  SELECT max(v.bucket) FROM vitals_rollups v
                  WHERE v.system = r.system AND v.bucket < requests.first_at - interval '5 minutes'
                ), '-infinity'),
                requests.last_at + interval '2 seconds', '[]')
          AND w.system = r.system AND w.harness = r.harness
          AND (w.cwd IS NULL OR w.cwd IN (s.first_cwd, s.last_cwd))
          AND w.window_from <= requests.last_at AND requests.first_at <= w.may_until
      ) procs
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE w.window_from <= r.at AND r.at <= w.may_until) AS candidates,
               min(w.id) FILTER (WHERE w.window_from <= r.at AND r.at <= w.may_until) AS only_id,
               max(w.window_from) FILTER (WHERE w.window_from <= r.at) AS opened,
               max(w.may_until) FILTER (WHERE w.may_until < r.at) AS closed,
               min(w.window_from) FILTER (WHERE w.window_from > r.at) AS opens,
               min(w.may_until) FILTER (WHERE w.may_until >= r.at) AS closes
        FROM unnest(procs.ids, procs.froms, procs.mays) AS w (id, window_from, may_until)
      ) near
      CROSS JOIN LATERAL (
        SELECT (
                 SELECT x.at FROM projected_requests x
                 WHERE x.harness = r.harness AND x.system = r.system AND x.source = r.source
                   AND x.session_id = r.session_id AND x.parser_version = r.parser_version
                   AND x.at >= COALESCE(near.opened, '-infinity')
                   AND x.at > COALESCE(near.closed, '-infinity')
                 ORDER BY x.at LIMIT 1
               ) AS first_at,
               (
                 SELECT x.at FROM projected_requests x
                 WHERE x.harness = r.harness AND x.system = r.system AND x.source = r.source
                   AND x.session_id = r.session_id AND x.parser_version = r.parser_version
                   AND x.at < COALESCE(near.opens, 'infinity')
                   AND x.at <= COALESCE(near.closes, 'infinity')
                 ORDER BY x.at DESC LIMIT 1
               ) AS last_at
        OFFSET 0
      ) stretch
      LEFT JOIN LATERAL (
        SELECT w.id AS process_id, w.pid FROM harness_process_windows w
        WHERE near.candidates = 1 AND w.id = near.only_id
          AND w.cwd IN (s.first_cwd, s.last_cwd)
          AND stretch.last_at <= w.ran_until
          AND (w.last_seen_at BETWEEN stretch.first_at AND stretch.last_at
               OR EXISTS (
                 SELECT 1 FROM harness_process_samples x
                 WHERE x.process = w.id AND x.t BETWEEN stretch.first_at AND stretch.last_at
               )
               OR EXISTS (
                 SELECT 1 FROM harness_process_rollups x
                 WHERE x.process = w.id AND x.bucket >= stretch.first_at
                   AND x.bucket + interval '5 minutes' <= stretch.last_at
               ))
        OFFSET 0
      ) k ON true;

      -- A stretch is read from its first request, so a filter on \`started_at\`
      -- reaches the requests' time index.
      CREATE VIEW insight.session_stretches WITH (security_barrier = true) AS
      SELECT DISTINCT ON (l.harness, l.system, l.source, l.session_id, l.at)
             l.harness, l.system, l.source, l.session_id, l.at AS started_at,
             l.stretch_ended_at AS ended_at,
             (SELECT count(*) FROM insight.requests x
              WHERE x.harness = l.harness AND x.system = l.system AND x.source = l.source
                AND x.session_id = l.session_id
                AND x.at BETWEEN l.at AND l.stretch_ended_at) AS requests,
             l.link, l.process_id, l.pid, l.candidates
      FROM insight.request_links l
      WHERE l.at = l.stretch_started_at
      ORDER BY l.harness, l.system, l.source, l.session_id, l.at, l.request_id;

      -- The oldest kept sample covers the 15 seconds before it. \`since\` comes
      -- from an aggregate, so it stays a plain column that a filter on a
      -- security barrier view can compare with.
      CREATE VIEW vitals_intervals AS
      SELECT v.system, v.t, prev.since
      FROM vitals_samples v
      CROSS JOIN LATERAL (
        SELECT COALESCE(max(x.t), v.t - interval '15 seconds') AS since
        FROM vitals_samples x WHERE x.system = v.system AND x.t < v.t
      ) prev;

      CREATE VIEW insight.vitals WITH (security_barrier = true) AS
      SELECT v.system, v.t, i.since, v.cpu_busy_percent, v.memory_used_bytes,
             v.memory_total_bytes, v.load_1
      FROM vitals_samples v JOIN vitals_intervals i ON i.system = v.system AND i.t = v.t;

      -- One row per sample and process. CPU cores are the tree's CPU seconds
      -- per second between the latest reading in the sample's interval and the
      -- reading before it.
      CREATE VIEW insight.vitals_processes WITH (security_barrier = true) AS
      SELECT i.system, i.t, p.harness, p.id AS process_id, p.pid, p.cwd,
             p.started_at AS process_started_at,
             r.t AS read_at, r.cpu_micros, r.rss_bytes,
             ((r.cpu_micros - prev.cpu_micros) / extract(epoch FROM r.t - prev.t) / 1e6)
               ::double precision AS cpu_cores
      FROM vitals_intervals i
      JOIN harness_processes p
        ON p.system = i.system
       AND tstzrange(p.started_at, CASE WHEN p.ended_at IS NULL THEN 'infinity'::timestamptz
                                        ELSE GREATEST(p.started_at, p.ended_at) END, '[]') @> i.t
      LEFT JOIN LATERAL (
        SELECT x.t, x.cpu_micros, x.rss_bytes FROM harness_process_samples x
        WHERE x.process = p.id AND x.t <= i.t AND x.t > i.since
        ORDER BY x.t DESC LIMIT 1
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT x.t, x.cpu_micros FROM harness_process_samples x
        WHERE x.process = p.id AND x.t < r.t
        ORDER BY x.t DESC LIMIT 1
      ) prev ON true;

      -- One row per sample, process, and Session: the Session's latest request
      -- at or before the sample opens the stretch that holds it, if any. A
      -- stretch lies within its Session's request span, which finds the
      -- Sessions by index; \`insight.request_links\` leaves out a Session a
      -- delete is deriving again.
      CREATE VIEW insight.vitals_sessions WITH (security_barrier = true) AS
      SELECT v.system, v.t, p.harness, p.id AS process_id, p.pid, l.source, l.session_id,
             l.stretch_started_at, l.stretch_ended_at
      FROM vitals_samples v
      JOIN harness_processes p
        ON p.system = v.system
       AND tstzrange(p.started_at, CASE WHEN p.ended_at IS NULL THEN 'infinity'::timestamptz
                                        ELSE GREATEST(p.started_at, p.ended_at) END, '[]') @> v.t
      JOIN projected_sessions s
        ON tstzrange(s.first_request_at, s.last_request_at, '[]') @> v.t
       AND s.first_request_at IS NOT NULL
       AND s.system = p.system AND s.harness = p.harness AND p.cwd IN (s.first_cwd, s.last_cwd)
      JOIN current_parsers c ON c.harness = s.harness AND c.version = s.parser_version
      CROSS JOIN LATERAL (
        SELECT x.request_id FROM projected_requests x
        WHERE x.harness = s.harness AND x.system = s.system AND x.source = s.source
          AND x.session_id = s.session_id AND x.parser_version = s.parser_version AND x.at <= v.t
        ORDER BY x.at DESC LIMIT 1
      ) latest
      CROSS JOIN LATERAL (
        SELECT x.source, x.session_id, x.process_id, x.stretch_started_at, x.stretch_ended_at
        FROM insight.request_links x
        WHERE x.harness = s.harness AND x.system = s.system AND x.source = s.source
          AND x.request_id = latest.request_id
        OFFSET 0
      ) l
      WHERE l.process_id = p.id AND v.t <= l.stretch_ended_at;

      CREATE VIEW insight.vitals_requests WITH (security_barrier = true) AS
      SELECT i.system, i.t, l.harness, l.source, l.session_id, l.agent_id, l.request_id, l.at,
             l.model, l.link, l.process_id, l.pid
      FROM vitals_intervals i
      CROSS JOIN LATERAL (
        SELECT * FROM insight.request_links x
        WHERE x.system = i.system AND x.at > i.since AND x.at <= i.t
        OFFSET 0
      ) l;
    `,
    version: 19,
  },
];

// Serializes Hubs that start against the same database at once. The name is
// arbitrary; it only has to be the same for every Hub. Loading the price table
// takes the lock too (price-table.ts).
export const MIGRATION_LOCK = 'heimdall-migrations';

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
