import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startCluster, stopOrphanedClusters } from './postgres.ts';

// Whether a process runs: it exists and is not a zombie waiting to be reaped.
const isRunning = async (pid: number) => {
  const ps = Bun.spawn(['ps', '-o', 'stat=', '-p', String(pid)], { stderr: 'ignore' });
  const state = (await new Response(ps.stdout).text()).trim();
  await ps.exited;
  return state !== '' && !state.startsWith('Z');
};

const postmasterPid = async (dir: string) =>
  Number((await readFile(join(dir, 'data', 'postmaster.pid'), 'utf8')).split('\n')[0]);

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

// The pid of a process that has already exited.
const deadPid = async () => {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
};

// A test run, reduced to starting the throwaway cluster and then waiting for its
// last test (`hold`) or stopping it the way the preload does.
const testRun = (finish: 'hold' | 'stop') =>
  Bun.spawn(
    [
      process.execPath,
      '--eval',
      `import { startTestServer, stopTestServer } from ${JSON.stringify(join(import.meta.dir, 'postgres.ts'))};
await startTestServer();
console.log('started');
${finish === 'hold' ? 'setInterval(() => {}, 60_000);' : 'await stopTestServer();'}`,
    ],
    { env: { ...process.env, HEIMDALL_TEST_DATABASE_URL: '' }, stderr: 'inherit' },
  );

// The cluster directory under the temporary directory that `pid` owns.
const clusterOwnedBy = async (pid: number) => {
  const dirs = (await readdir(tmpdir()))
    .filter((name) => name.startsWith('heimdall-pg-'))
    .map((name) => join(tmpdir(), name));
  const owners = await Promise.all(
    dirs.map(async (dir) => readFile(join(dir, 'owner'), 'utf8').catch(() => '')),
  );
  const dir = dirs[owners.indexOf(String(pid))];
  if (dir === undefined) {
    throw new Error(`No cluster is owned by ${String(pid)}`);
  }
  return dir;
};

// Runs under the real temporary directory with real owners, so whatever this
// test leaves behind if it is itself killed is what the next run sweeps. It
// needs `initdb` and `pg_ctl`, which only a System that starts throwaway
// clusters, and so can leak them, has.
test.skipIf(Bun.which('initdb') === null || Bun.which('pg_ctl') === null)(
  'a run stops the cluster a killed run left behind, and leaves a live run’s cluster running',
  async () => {
    const liveDir = await mkdtemp(join(tmpdir(), 'heimdall-pg-'));
    const live = await startCluster(liveDir, process.pid);
    const killed = testRun('hold');
    try {
      const reader = killed.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('started');
      const killedDir = await clusterOwnedBy(killed.pid);
      const killedServer = await postmasterPid(killedDir);
      killed.kill('SIGKILL');
      await killed.exited;
      expect(await isRunning(killedServer)).toBe(true);

      expect(await testRun('stop').exited).toBe(0);

      expect(await isRunning(killedServer)).toBe(false);
      expect(await exists(killedDir)).toBe(false);
      expect(await isRunning(await postmasterPid(liveDir))).toBe(true);
    } finally {
      killed.kill('SIGKILL');
      await live.stop();
    }
  },
  60_000,
);

test('the sweep leaves a directory with no owner, and signals no process a stale pid file names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'heimdall-sweep-'));
  const unownedDir = join(root, 'heimdall-pg-unowned');
  const staleDir = join(root, 'heimdall-pg-stale');
  const bystander = Bun.spawn(['sleep', '60']);
  try {
    await mkdir(unownedDir);
    await mkdir(join(staleDir, 'data'), { recursive: true });
    await writeFile(join(staleDir, 'owner'), String(await deadPid()));
    await writeFile(join(staleDir, 'data', 'postmaster.pid'), `${String(bystander.pid)}\n`);

    await stopOrphanedClusters(root);

    expect(await exists(unownedDir)).toBe(true);
    expect(await exists(staleDir)).toBe(false);
    expect(await isRunning(bystander.pid)).toBe(true);
  } finally {
    bystander.kill();
    await rm(root, { force: true, recursive: true });
  }
});
