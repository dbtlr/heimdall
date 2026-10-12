import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQL } from 'bun';

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
