import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQL } from 'bun';

// The server tests run against: the one `HEIMDALL_TEST_DATABASE_URL` names, or
// else a throwaway cluster started from the `initdb` and `pg_ctl` on PATH on
// first use. The test preload stops it after the last test.
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

const startThrowawayCluster = async (): Promise<URL> => {
  const dir = await mkdtemp(join(tmpdir(), 'heimdall-pg-'));
  const data = join(dir, 'data');
  const port = freePort();
  try {
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
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
  stopThrowawayCluster = async () => {
    await run('pg_ctl', ['stop', '--pgdata', data, '--mode', 'immediate']);
    await rm(dir, { force: true, recursive: true });
  };
  return new URL(`postgres://postgres@127.0.0.1:${String(port)}/postgres`);
};

const testServer = () => {
  const configured = process.env.HEIMDALL_TEST_DATABASE_URL;
  server ??=
    configured === undefined || configured === ''
      ? startThrowawayCluster()
      : Promise.resolve(new URL(configured));
  return server;
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
  // A zone with DST, so nothing passes only because the session happens to be UTC.
  await admin.unsafe(`ALTER DATABASE ${name} SET TimeZone TO 'America/New_York'`);
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
