import { beforeAll, describe, expect, test } from 'bun:test';

import { SQL } from 'bun';

import {
  grantInsightReader,
  INSIGHT_READER_ROLE,
  keepInsightReaderGranted,
  revokePublicTemporaryTables,
} from './insight-reader.ts';
import { migrate, MIGRATION_LOCK, MIGRATIONS } from './migrations.ts';
import { syncPrices } from './price-table.ts';
import { configArgs, hubConfig, invoke } from './testing/cli.ts';
import { startTestServer, testDatabase } from './testing/postgres.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

type Db = Awaited<ReturnType<typeof testDatabase>>;

// Creates login role `name` as a provisioner would, with a password, since a
// server such as CI's asks every login for one, and connects to `db` as it.
const loginRole = async (db: Db, name: string) => {
  const password = crypto.randomUUID();
  await db.sql.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  const url = new URL(db.url);
  url.username = name;
  url.password = password;
  return new SQL(url.href);
};

// A login role on the test server, as a provisioner would create the reader,
// with a connection to `db` as that role. Roles belong to the whole server, so
// each test's is named afresh, and disposing it drops what it was granted
// first, as DROP ROLE requires.
const testRole = async (db: Db) => {
  const name = `heimdall_reader_${crypto.randomUUID().replaceAll('-', '')}`;
  const sql = await loginRole(db, name);
  return {
    name,
    sql,
    [Symbol.asyncDispose]: async () => {
      await sql.close();
      await db.sql.unsafe(`DROP OWNED BY ${name}`);
      await db.sql.unsafe(`DROP ROLE ${name}`);
    },
  };
};

// A role name no role on the server has.
const absentRole = () => `heimdall_absent_${crypto.randomUUID().replaceAll('-', '')}`;

const insightViews = async (sql: SQL) => {
  const rows: { table_name: string }[] = await sql`
    SELECT table_name FROM information_schema.views WHERE table_schema = 'insight'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
};

// Every table and view in the public schema, each with a column a write can
// name: one that is neither an identity nor generated.
const publicTables = async (sql: SQL) => {
  const rows: { column: string; name: string }[] = await sql`
    SELECT DISTINCT ON (c.relname) c.relname AS name, a.attname AS column
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attidentity = '' AND a.attgenerated = ''
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY c.relname, a.attnum
  `;
  return rows.map(({ column, name }) => ({ column, name }));
};

// The SQLSTATE a statement fails with, or undefined when it succeeds.
const failureOf = async (statement: Promise<unknown>) => {
  try {
    await statement;
    return undefined;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'errno' in error ? error.errno : error;
  }
};

// What a query answers, as plain rows.
const rowsOf = async (query: Promise<unknown>) => [...((await query) as unknown[])];

const INSUFFICIENT_PRIVILEGE = '42501';
const NOT_UPDATABLE = '55000';

// One Session in the insight views, written straight into the tables the views read.
const seedSession = async (sql: SQL) => {
  await sql`
    INSERT INTO systems (name, last_seen_at, collector_version, collector_platform, collector_arch)
    VALUES ('laptop-1', now(), '0.1.0', 'darwin', 'arm64')
  `;
  await sql`INSERT INTO current_parsers (harness, version) VALUES ('claude-code', 1)`;
  await sql`
    INSERT INTO projected_sessions (harness, parser_version, system, source, session_id)
    VALUES ('claude-code', 1, 'laptop-1', 'claude-code', 's-1')
  `;
};

describe('grantInsightReader', () => {
  test('lets the role read every insight view, through the views alone', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await seedSession(db.sql);
    await using reader = await testRole(db);

    expect(await grantInsightReader(db.sql, reader.name)).toEqual({ kind: 'granted' });

    const views = await insightViews(db.sql);
    expect(views).toContain('sessions');
    expect(views).toContain('parse_status');
    for (const view of views) {
      // oxlint-disable-next-line no-await-in-loop -- one view at a time names the one that fails.
      expect(await failureOf(reader.sql.unsafe(`SELECT * FROM insight.${view}`))).toBeUndefined();
    }
    expect(await rowsOf(reader.sql`SELECT session_id FROM insight.sessions`)).toEqual([
      { session_id: 's-1' },
    ]);
  });

  test("lets the role read a request's list-price cost, which the views compute from the price table", async () => {
    // The views read `model_prices` with their owner's rights, and the
    // function that prices tokens reads no table, so the reader needs neither.
    await using db = await testDatabase();
    await migrate(db.sql);
    await seedSession(db.sql);
    await syncPrices(db.sql, {
      bundled: [
        { contextWindow: 200_000, input: 3, model: 'priced', output: 15, validFrom: '2026-01-01' },
      ],
      configured: [],
    });
    await db.sql`
      INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
      VALUES (1, 'laptop-1', 'claude-code', 'projects/p/s.jsonl', now(), now())
    `;
    await db.sql`
      INSERT INTO projected_requests (
        harness, parser_version, system, source, session_id, request_id, at, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, generation, byte_offset
      )
      VALUES ('claude-code', 1, 'laptop-1', 'claude-code', 's-1', 'r-1', '2026-06-01T00:00:00Z',
              'priced', 1000000, 0, 0, 0, 1, 0)
    `;
    await using reader = await testRole(db);
    await grantInsightReader(db.sql, reader.name);

    const rows: { cost_usd: string }[] = await reader.sql`SELECT cost_usd FROM insight.requests`;

    expect(rows.map((row) => Number(row.cost_usd))).toEqual([3]);
  });

  test('lets the role read a view a later migration creates or replaces, at once and after the Hub starts again', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using reader = await testRole(db);
    await grantInsightReader(db.sql, reader.name);

    // A later migration that adds a view and replaces one by dropping it,
    // which drops the privileges granted on it.
    await migrate(db.sql, [
      ...MIGRATIONS,
      {
        sql: `
          CREATE VIEW insight.later WITH (security_barrier = true) AS SELECT 1 AS one;
          DROP VIEW insight.parse_status;
          CREATE VIEW insight.parse_status WITH (security_barrier = true) AS SELECT 1 AS one;
        `,
        version: 9999,
      },
    ]);

    expect(await rowsOf(reader.sql`SELECT one FROM insight.later`)).toEqual([{ one: 1 }]);
    expect(await rowsOf(reader.sql`SELECT one FROM insight.parse_status`)).toEqual([{ one: 1 }]);

    expect(await grantInsightReader(db.sql, reader.name)).toEqual({ kind: 'granted' });
    expect(await rowsOf(reader.sql`SELECT one FROM insight.later`)).toEqual([{ one: 1 }]);
    expect(await rowsOf(reader.sql`SELECT one FROM insight.parse_status`)).toEqual([{ one: 1 }]);
  });

  test('grants nothing to a role that does not exist yet, and grants it once it does', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    const name = absentRole();

    expect(await grantInsightReader(db.sql, name)).toEqual({ kind: 'absent' });

    const reader = await loginRole(db, name);
    try {
      expect(await failureOf(reader`SELECT * FROM insight.sessions`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await grantInsightReader(db.sql, name)).toEqual({ kind: 'granted' });
      expect(await failureOf(reader`SELECT * FROM insight.sessions`)).toBeUndefined();
    } finally {
      await reader.close();
      await db.sql.unsafe(`DROP OWNED BY ${name}`);
      await db.sql.unsafe(`DROP ROLE ${name}`);
    }
  });

  test("refuses the Hub's own role, a superuser, and a member of the Hub's role", async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using superuser = await testRole(db);
    await db.sql.unsafe(`ALTER ROLE ${superuser.name} SUPERUSER`);
    await using member = await testRole(db);
    const [{ hub } = { hub: '' }]: { hub: string }[] = await db.sql`SELECT current_user AS hub`;
    await db.sql.unsafe(`GRANT ${hub} TO ${member.name}`);

    expect(await grantInsightReader(db.sql, hub)).toEqual({ kind: 'refused', reason: 'hub' });
    expect(await grantInsightReader(db.sql, superuser.name)).toEqual({
      kind: 'refused',
      reason: 'superuser',
    });
    expect(await grantInsightReader(db.sql, member.name)).toEqual({
      kind: 'refused',
      reason: 'member',
    });
  });

  test('refuses a member of pg_read_all_data, which reads every table already', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using reader = await testRole(db);
    await db.sql.unsafe(`GRANT pg_read_all_data TO ${reader.name}`);

    expect(await grantInsightReader(db.sql, reader.name)).toEqual({
      kind: 'refused',
      reason: 'readsAll',
    });
  });

  test('granting again changes nothing', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using reader = await testRole(db);

    await grantInsightReader(db.sql, reader.name);
    expect(await grantInsightReader(db.sql, reader.name)).toEqual({ kind: 'granted' });

    expect(await failureOf(reader.sql`SELECT * FROM insight.sessions`)).toBeUndefined();
  });

  test('leaves the role unable to read or write any table, or write through a view', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await seedSession(db.sql);
    await using reader = await testRole(db);
    await grantInsightReader(db.sql, reader.name);

    const tables = await publicTables(db.sql);
    const names = tables.map((table) => table.name);
    for (const name of ['transcript_chunks', 'transcript_generations', 'projected_sessions']) {
      expect(names).toContain(name);
    }
    for (const { column, name } of tables) {
      const statements = [
        `SELECT * FROM ${name}`,
        `INSERT INTO ${name} DEFAULT VALUES`,
        `UPDATE ${name} SET ${column} = ${column}`,
        `DELETE FROM ${name}`,
      ];
      for (const statement of statements) {
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time names the one that passes.
        expect([statement, await failureOf(reader.sql.unsafe(statement))]).toEqual([
          statement,
          INSUFFICIENT_PRIVILEGE,
        ]);
      }
    }
    for (const view of await insightViews(db.sql)) {
      for (const statement of [
        `INSERT INTO insight.${view} DEFAULT VALUES`,
        `UPDATE insight.${view} SET harness = harness`,
        `DELETE FROM insight.${view}`,
      ]) {
        // A view that joins or groups refuses a write before it checks privileges.
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time names the one that passes.
        const failure = await failureOf(reader.sql.unsafe(statement));
        expect([
          statement,
          [INSUFFICIENT_PRIVILEGE, NOT_UPDATABLE].includes(String(failure)),
        ]).toEqual([statement, true]);
      }
    }
    for (const statement of [
      'CREATE TABLE public.scratch (a int)',
      'CREATE VIEW insight.scratch AS SELECT 1 AS one',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one statement at a time names the one that passes.
      expect([statement, await failureOf(reader.sql.unsafe(statement))]).toEqual([
        statement,
        INSUFFICIENT_PRIVILEGE,
      ]);
    }
  });
});

// Rows the views must hide beside one they show: a Session a delete is
// deriving again, a Session of a parser version that is not current, and a
// deleted generation, each holding a value a probe tries to surface.
const seedHidden = async (sql: SQL) => {
  await seedSession(sql);
  await sql`
    INSERT INTO projected_sessions (harness, parser_version, system, source, session_id, first_cwd)
    VALUES ('claude-code', 1, 'laptop-1', 'claude-code', 's-hidden', '/hidden/rederiving'),
           ('claude-code', 2, 'laptop-1', 'claude-code', 's-old', '/hidden/other-version')
  `;
  await sql`
    INSERT INTO rederiving_sessions (harness, system, source, session_id)
    VALUES ('claude-code', 'laptop-1', 'claude-code', 's-hidden')
  `;
  await sql`
    INSERT INTO transcript_generations (id, system, source, path, held, opened_at, last_upload_at, deleted_at)
    VALUES (1, 'laptop-1', 'claude-code', 'visible.jsonl', 0, now(), now(), NULL),
           (2, 'laptop-1', 'claude-code', 'hidden/deleted-path', 0, now(), now(), now())
  `;
  await sql`
    INSERT INTO projected_requests (
      harness, parser_version, system, source, session_id, request_id, at, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, generation, byte_offset
    )
    VALUES ('claude-code', 1, 'laptop-1', 'claude-code', 's-1', 'msg_a', now(), 'claude-sonnet-5-5',
            1, 1, 0, 0, 1, 0)
  `;
};

describe('the insight views', () => {
  test('are all the insight schema holds, since the reader is granted every table there', async () => {
    // PostgreSQL's grants and default privileges cannot tell a view from a
    // table, so a table or materialized view a later migration put in
    // `insight` would be the reader's to read.
    await using db = await testDatabase();
    await migrate(db.sql);

    const others: { kind: string; name: string }[] = await db.sql`
      SELECT c.relname AS name, c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'insight' AND c.relkind <> 'v'
      ORDER BY c.relname
    `;

    expect(others).toEqual([]);
  });

  test('are every one a security barrier, so a reader filter runs only on rows a view shows', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);

    const views: { barrier: boolean; name: string }[] = await db.sql`
      SELECT c.relname AS name,
             COALESCE(c.reloptions @> ARRAY['security_barrier=true'], false) AS barrier
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'insight' AND c.relkind = 'v'
      ORDER BY c.relname
    `;

    expect(views.length).toBeGreaterThan(0);
    expect(views.filter((view) => !view.barrier).map((view) => view.name)).toEqual([]);
  });

  test("never show a hidden Session's values through an error a reader's filter raises", async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await seedHidden(db.sql);
    await using reader = await testRole(db);
    await grantInsightReader(db.sql, reader.name);

    const rows = await rowsOf(
      reader.sql`SELECT session_id FROM insight.sessions WHERE session_id <> 's-1' AND first_cwd::int = 0`,
    );

    expect(rows).toEqual([]);
  });

  test("never show a deleted generation's path through an error a reader's filter raises", async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await seedHidden(db.sql);
    await using reader = await testRole(db);
    await grantInsightReader(db.sql, reader.name);

    // Hash joins scan every generation before the join drops the ones no request names.
    const rows = await reader.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_nestloop = off`;
      await tx`SET LOCAL enable_mergejoin = off`;
      return rowsOf(
        tx`SELECT request_id FROM insight.requests WHERE path <> 'visible.jsonl' AND path::int = 0`,
      );
    });

    expect(rows).toEqual([]);
  });
});

describe('revokePublicTemporaryTables', () => {
  test('stops every other role creating temporary tables in a database the Hub owns', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using reader = await testRole(db);

    expect(await revokePublicTemporaryTables(db.sql)).toBe(true);

    expect(await failureOf(reader.sql`CREATE TEMPORARY TABLE scratch (a int)`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await failureOf(db.sql`CREATE TEMPORARY TABLE scratch (a int)`)).toBeUndefined();
  });

  test("changes nothing in a database the Hub's role does not own", async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using hub = await testRole(db);

    expect(await revokePublicTemporaryTables(hub.sql)).toBe(false);

    expect(await failureOf(hub.sql`CREATE TEMPORARY TABLE scratch (a int)`)).toBeUndefined();
  });
});

// A runtime log that keeps its lines.
const memoryLog = () => {
  const lines: string[] = [];
  return {
    lines,
    log: {
      fatal: (message: string): never => {
        throw new Error(message);
      },
      info: async (message: string) => {
        lines.push(`info: ${message}`);
      },
      warn: async (message: string) => {
        lines.push(`warning: ${message}`);
      },
    },
  };
};

// Waits until `done` holds, checking every few milliseconds, for at most 5 seconds.
const eventually = async (done: () => boolean) => {
  const until = Date.now() + 5000;
  while (!done() && Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- polls until it holds.
    await Bun.sleep(10);
  }
};

describe('keepInsightReaderGranted', () => {
  test('grants a role the provisioner creates after serve started, then stops trying', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    const name = absentRole();
    const { lines, log } = memoryLog();
    const granted = `info: Granted ${name} read access to the insight views.`;

    const stop = await keepInsightReaderGranted({ intervalMs: 20, log, reader: name, sql: db.sql });
    try {
      expect(
        lines.some((line) => line.startsWith(`warning: The insight reader role ${name}`)),
      ).toBe(true);
      await db.sql.unsafe(`CREATE ROLE ${name} LOGIN`);
      await eventually(() => lines.includes(granted));
      await Bun.sleep(100);

      expect(lines.filter((line) => line === granted)).toHaveLength(1);
      const tries = lines.length;
      await Bun.sleep(100);
      expect(lines).toHaveLength(tries);
    } finally {
      await stop();
      await db.sql.unsafe(`DROP OWNED BY ${name}`);
      await db.sql.unsafe(`DROP ROLE ${name}`);
    }
  });

  test('says once that a role does not exist, however often it tries', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    const name = absentRole();
    const { lines, log } = memoryLog();

    const stop = await keepInsightReaderGranted({ intervalMs: 10, log, reader: name, sql: db.sql });
    await Bun.sleep(100);
    await stop();

    expect(lines.filter((line) => line.includes('does not exist'))).toHaveLength(1);
  });

  test('tries again after a grant that fails', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using reader = await testRole(db);
    const { lines, log } = memoryLog();
    // The grant waits on the migration lock, which this session holds, until its lock timeout.
    const holder = await db.sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;

    const stop = await keepInsightReaderGranted({
      intervalMs: 20,
      lockTimeoutMs: 50,
      log,
      reader: reader.name,
      sql: db.sql,
    });
    try {
      expect(lines.some((line) => line.startsWith('warning: Could not grant'))).toBe(true);
      await holder`ROLLBACK`;
      holder.release();
      await eventually(() => lines.some((line) => line.startsWith('info: Granted')));
    } finally {
      await stop();
    }

    expect(await failureOf(reader.sql`SELECT * FROM insight.sessions`)).toBeUndefined();
  });

  test('stops other roles creating temporary tables', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    await using reader = await testRole(db);
    const { log } = memoryLog();

    const stop = await keepInsightReaderGranted({ log, reader: reader.name, sql: db.sql });
    await stop();

    expect(await failureOf(reader.sql`CREATE TEMPORARY TABLE scratch (a int)`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  test('refuses a role that reads everything already, says why, and does not try again', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    const [{ hub } = { hub: '' }]: { hub: string }[] = await db.sql`SELECT current_user AS hub`;
    const { lines, log } = memoryLog();

    const stop = await keepInsightReaderGranted({ intervalMs: 10, log, reader: hub, sql: db.sql });
    await Bun.sleep(60);
    await stop();

    expect(lines).toEqual([
      `warning: Granted ${hub} nothing: it is the Hub's own role, which reads every table. Name a role of its own as the insight reader.`,
    ]);
  });
});

describe('INSIGHT_READER_ROLE', () => {
  test('takes a plain lowercase role name', () => {
    for (const name of ['heimdall_insight', '_reader', 'r2']) {
      expect([name, INSIGHT_READER_ROLE.test(name)]).toEqual([name, true]);
    }
  });

  test('refuses a name PostgreSQL reserves or that would need quoting', () => {
    for (const name of [
      'public',
      'none',
      'pg_read_all_data',
      'Reader',
      'a-b',
      'a"b',
      '',
      'x'.repeat(64),
    ]) {
      expect([name, INSIGHT_READER_ROLE.test(name)]).toEqual([name, false]);
    }
  });
});

describe('serve', () => {
  test('grants the reader its configuration names, after the migrations, and says so', async () => {
    await using db = await testDatabase();
    await using reader = await testRole(db);
    await using config = await hubConfig(db, [`insight_reader = "${reader.name}"`]);
    let failure: unknown = 'not served';

    const { code, stderr, stdout } = await invoke(['serve', ...configArgs(config)], {
      whileServing: async () => {
        failure = await failureOf(reader.sql`SELECT * FROM insight.sessions`);
      },
    });

    expect(failure).toBeUndefined();
    expect(stdout).toContain(`Granted ${reader.name} read access to the insight views.`);
    expect(stderr).toBe('');
    expect(code).toBe(130);
  });

  test('starts when the reader does not exist yet, and says it granted the role nothing', async () => {
    await using db = await testDatabase();
    const name = absentRole();
    await using config = await hubConfig(db, [`insight_reader = "${name}"`]);

    const { code, stdout } = await invoke(['serve', ...configArgs(config)]);

    expect(stdout).toContain(
      `warning: The insight reader role ${name} does not exist yet, so serve granted it nothing.`,
    );
    expect(stdout).toContain('Listening on');
    expect(code).toBe(130);
  });

  test('grants nothing when no reader is configured', async () => {
    await using db = await testDatabase();
    await using reader = await testRole(db);
    await using config = await hubConfig(db);

    const { stdout } = await invoke(['serve', ...configArgs(config)]);

    expect(stdout).toContain('Listening on');
    expect(stdout).not.toContain('insight views');
    expect(await failureOf(reader.sql`SELECT * FROM insight.sessions`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  test('refuses a reader name that is not a plain role name', async () => {
    await using db = await testDatabase();
    await using config = await hubConfig(db, ['insight_reader = "public"']);

    const { code, stderr } = await invoke(['serve', ...configArgs(config)]);

    expect(stderr).toContain('insight-reader');
    expect(code).toBe(2);
  });
});
