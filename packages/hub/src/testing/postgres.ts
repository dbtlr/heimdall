import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQL } from 'bun';

import { migrate } from '../migrations.ts';

// The server tests run against: the one `HEIMDALL_TEST_DATABASE_URL` names, or
// else a throwaway cluster started from the `initdb` and `pg_ctl` on PATH on
// first use. The test preload stops it after the last test, and a later run
// stops it if this run is killed first.
let server: Promise<URL> | undefined;
let stopThrowawayCluster: (() => Promise<void>) | undefined;

const run = async (command: string, args: string[]) => {
  let failure: string;
  try {
    const child = Bun.spawn([command, ...args], { stderr: 'pipe', stdout: 'ignore' });
    if ((await child.exited) === 0) {
      return;
    }
    failure = await new Response(child.stderr).text();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `${command} failed. Set HEIMDALL_TEST_DATABASE_URL to a PostgreSQL server, or put PostgreSQL's initdb and pg_ctl on PATH.\n${failure}`,
  );
};

// A TCP port nothing listens on right now, from the operating system.
const freePort = () => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

// Each cluster directory records the pid of the test process that started it in
// an `owner` file, so a later run can tell a cluster whose run was killed from
// one still in use.
const CLUSTER_PREFIX = 'heimdall-pg-';
const OWNER_FILE = 'owner';

// Starts a cluster in `dir`, an empty directory, owned by the process `owner`.
export const startCluster = async (dir: string, owner: number) => {
  await writeFile(join(dir, OWNER_FILE), String(owner));
  const data = join(dir, 'data');
  const port = freePort();
  await run('initdb', ['--auth=trust', '--username=postgres', '--no-sync', '--pgdata', data]);
  await run('pg_ctl', [
    'start',
    '--pgdata',
    data,
    '--log',
    join(dir, 'server.log'),
    '--wait',
    '--options',
    `-c listen_addresses=127.0.0.1 -c port=${String(port)} -c unix_socket_directories='${dir}' -c fsync=off`,
  ]);
  return {
    stop: () => stopCluster(dir),
    url: new URL(`postgres://postgres@127.0.0.1:${String(port)}/postgres`),
  };
};

// Whether the server a data directory's `postmaster.pid` names still runs. The
// pid must belong to a `postgres` process: a server that died without removing
// the file leaves a pid the system may since have given to anything else, and
// `pg_ctl` would signal it.
const serverRuns = async (data: string) => {
  let pid: string | undefined;
  try {
    [pid] = (await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n');
  } catch {
    return false;
  }
  const ps = Bun.spawn(['ps', '-o', 'comm=', '-p', String(pid)], { stderr: 'ignore' });
  const command = (await new Response(ps.stdout).text()).trim();
  await ps.exited;
  return command.endsWith('postgres');
};

const stopCluster = async (dir: string) => {
  const data = join(dir, 'data');
  if (await serverRuns(data)) {
    try {
      await run('pg_ctl', ['stop', '--pgdata', data, '--mode', 'immediate']);
    } catch (error) {
      // Another run's sweep may have stopped it first.
      if (await serverRuns(data)) {
        throw error;
      }
    }
  }
  await rm(dir, { force: true, recursive: true });
};

// Whether a process with this pid exists. EPERM means it exists as another user.
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
};

// The pid a cluster directory names as its owner, or undefined when it names
// none, cannot be read, or belongs to another user. `/tmp` is shared, and
// `pg_ctl stop` signals whatever pid a directory's `postmaster.pid` names, so
// only this user's own directories count. A reused owner pid only delays the
// cleanup.
const ownerOf = async (dir: string) => {
  try {
    if ((await lstat(dir)).uid !== process.getuid?.()) {
      return undefined;
    }
    const owner = Number.parseInt(await readFile(join(dir, OWNER_FILE), 'utf8'), 10);
    return Number.isNaN(owner) ? undefined : owner;
  } catch {
    return undefined;
  }
};

const stopIfOrphaned = async (dir: string) => {
  const owner = await ownerOf(dir);
  if (owner === undefined || isAlive(owner)) {
    return;
  }
  try {
    await stopCluster(dir);
  } catch (error) {
    console.warn(`Could not stop the orphaned test cluster in ${dir}: ${String(error)}`);
  }
};

// Stops and removes each cluster under `root` whose owning process is gone,
// which is what a killed test run leaves behind. A directory without an owner
// may be one another run is still creating, so it is left alone.
export const stopOrphanedClusters = async (root: string) => {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(CLUSTER_PREFIX))
      .map((entry) => stopIfOrphaned(join(root, entry.name))),
  );
};

const startThrowawayCluster = async (): Promise<URL> => {
  await stopOrphanedClusters(tmpdir());
  const dir = await mkdtemp(join(tmpdir(), CLUSTER_PREFIX));
  try {
    const cluster = await startCluster(dir, process.pid);
    stopThrowawayCluster = cluster.stop;
    return cluster.url;
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
};

const testServer = () => {
  const configured = process.env.HEIMDALL_TEST_DATABASE_URL;
  server ??=
    configured === undefined || configured === ''
      ? startThrowawayCluster()
      : Promise.resolve(new URL(configured));
  return server;
};

// Starts the test server, if it is not running, so a file whose first test is
// timed can pay for `initdb` in `beforeAll`: `beforeAll(startTestServer, 60_000)`.
export const startTestServer = async () => {
  await testServer();
};

// Stops the throwaway cluster, if this run started one.
export const stopTestServer = async () => {
  const stop = stopThrowawayCluster;
  stopThrowawayCluster = undefined;
  server = undefined;
  await stop?.();
};

// What a test may change in a migrated database's schema: relations and their
// columns, privileges, constraints, triggers, functions, view definitions, and
// database settings, plus the migrations applied.
const SCHEMA_FINGERPRINT = `
  SELECT md5(string_agg(item, '|' ORDER BY item)) AS fingerprint FROM (
    SELECT 'r' || c.oid::regclass::text || c.relkind::text || coalesce(c.relacl::text, '')
      || coalesce(md5(pg_get_viewdef(c.oid)), '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT 'a' || a.attrelid::regclass::text || a.attname || a.atttypid::text || a.attnotnull::text
      || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
      AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'k' || conname || conrelid::regclass::text || pg_get_constraintdef(oid) FROM pg_constraint
    WHERE connamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'pg\\_%')
    UNION ALL
    SELECT 't' || tgname || tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal
    UNION ALL
    SELECT 'p' || p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT 'n' || nspname || coalesce(nspacl::text, '') FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
    UNION ALL
    SELECT 's' || array_to_string(setconfig, ',') FROM pg_db_role_setting
    WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
    UNION ALL
    SELECT 'm' || version::text FROM schema_migrations
  ) items(item)`;

const fingerprint = async (sql: SQL) => {
  const [row]: { fingerprint: string }[] = await sql.unsafe(SCHEMA_FINGERPRINT);
  return row?.fingerprint;
};

// A migrated database, kept to be reused, with the schema's fingerprint just
// after migrating and the script that returns it to that moment.
const migrateShared = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  await db.sql.close();
  // One connection, so ending every other connection to the database leaves it working.
  const own = new SQL(db.url.href, { max: 1 });
  const tables: { name: string }[] = await own`
    SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
    WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname <> 'information_schema'
      AND tablename <> 'schema_migrations'`;
  const sequences: { name: string }[] = await own`
    SELECT format('%I.%I', schemaname, sequencename) AS name FROM pg_sequences
    WHERE schemaname NOT LIKE 'pg\\_%'`;
  const seeds = await Promise.all(
    tables.map(async ({ name }) => {
      const [row]: { rows: string | null }[] = await own.unsafe(
        `SELECT quote_literal(json_agg(t)::text) AS rows FROM ${name} t`,
      );
      return row?.rows == null
        ? []
        : [`INSERT INTO ${name} SELECT * FROM json_populate_recordset(NULL::${name}, ${row.rows})`];
    }),
  );
  // Ends the connections an earlier test left open, as dropping a database with
  // FORCE would, then empties and refills the tables as migrating left them,
  // firing none of the triggers a delete or an insert would, such as the price
  // table's staleness marks, and so checking no foreign key on the way.
  const reset = [
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    'BEGIN',
    'SET LOCAL session_replication_role = replica',
    // DELETE, since TRUNCATE gives every table new files and costs 20 times as much here.
    ...tables.map(({ name }) => `DELETE FROM ${name}`),
    ...sequences.map(({ name }) => `ALTER SEQUENCE ${name} RESTART`),
    ...seeds.flat(),
    'COMMIT',
  ].join(';\n');
  return { db, own, reset, schema: await fingerprint(own) };
};

type Shared = Awaited<ReturnType<typeof migrateShared>>;
let shared: Promise<Shared> | undefined;
let sharedInUse = false;

// A database migrated to the current schema, holding only what migrating seeds:
// `await using db = await migratedDatabase()`. Tests reuse one such database,
// reset between them, since migrating a fresh one costs about a third of a
// second (HMD-194). A test that changes its schema gets a newly migrated one
// next time, and one asked for while another is in use is fresh and its own.
export const migratedDatabase = async () => {
  if (sharedInUse) {
    const db = await testDatabase();
    await migrate(db.sql);
    return db;
  }
  sharedInUse = true;
  try {
    shared ??= migrateShared();
    let current = await shared;
    if ((await fingerprint(current.own)) === current.schema) {
      await current.own.unsafe(current.reset);
    } else {
      await current.own.close();
      await current.db[Symbol.asyncDispose]();
      shared = migrateShared();
      current = await shared;
    }
    const sql = new SQL(current.db.url.href);
    return {
      sql,
      url: current.db.url,
      [Symbol.asyncDispose]: async () => {
        await sql.close();
        sharedInUse = false;
      },
    };
  } catch (error) {
    // The next test starts from a newly migrated database rather than a failed one.
    shared = undefined;
    sharedInUse = false;
    throw error;
  }
};

// A fresh, empty database that drops itself when disposed:
// `await using db = await testDatabase()`.
export const testDatabase = async () => {
  const serverUrl = await testServer();
  const name = `heimdall_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(serverUrl.href);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  try {
    // A zone with DST, so nothing passes only because the session happens to be UTC.
    await admin.unsafe(`ALTER DATABASE ${name} SET TimeZone TO 'America/New_York'`);
  } catch (error) {
    await admin.unsafe(`DROP DATABASE ${name}`);
    await admin.close();
    throw error;
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const sql = new SQL(url.href);
  return {
    sql,
    url,
    [Symbol.asyncDispose]: async () => {
      await sql.close();
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
};
