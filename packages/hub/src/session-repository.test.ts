import { beforeAll, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { migrate } from './migrations.ts';
import { startTestServer, testDatabase } from './testing/postgres.ts';
import { timeline } from './testing/timeline.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

const T0 = Date.parse('2026-10-01T12:00:00Z');
const { addProcess, addSession } = timeline(T0);

const MAIN = '/work/project';
const LINKED = '/trees/feature';

const database = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  await db.sql`
    INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now()), ('server-1', now())
  `;
  return db;
};

const repositories = async (sql: SQL) => {
  const rows: { repository: string | null; session_id: string }[] = await sql`
    SELECT session_id, repository FROM insight.sessions ORDER BY session_id
  `;
  return Object.fromEntries(rows.map((row) => [row.session_id, row.repository]));
};

test('a Session in a linked worktree takes the repository its process reported', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 100, repository: MAIN, start: 0 });
  await addSession(db.sql, { firstCwd: LINKED, id: 's1', requests: [3, 200] });

  expect(await repositories(db.sql)).toEqual({ s1: MAIN });
});

test('a Session no process ran in has no repository', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 100, repository: MAIN, start: 0 });
  await addSession(db.sql, { firstCwd: '/elsewhere', id: 's1', requests: [3, 200] });

  expect(await repositories(db.sql)).toEqual({ s1: null });
});

test('a Session whose process reported no repository has none', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 100, start: 0 });
  await addSession(db.sql, { firstCwd: LINKED, id: 's1', requests: [3, 200] });

  expect(await repositories(db.sql)).toEqual({ s1: null });
});

test('a Session matches on the directory it ended in, not the one it began in', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 100, repository: MAIN, start: 0 });
  await addSession(db.sql, {
    firstCwd: LINKED,
    id: 's1',
    lastCwd: '/elsewhere',
    requests: [3, 200],
  });
  await addSession(db.sql, {
    firstCwd: '/elsewhere',
    id: 's2',
    lastCwd: LINKED,
    requests: [3, 200],
  });

  expect(await repositories(db.sql)).toEqual({ s1: null, s2: MAIN });
});

test('the most recent process with a repository names it, and a newer one without is passed over', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: LINKED, end: 100, pid: 100, repository: '/work/old', start: 0 });
  await addProcess(db.sql, { cwd: LINKED, end: 300, pid: 101, repository: MAIN, start: 200 });
  await addProcess(db.sql, { cwd: LINKED, end: 500, pid: 102, start: 400 });
  await addSession(db.sql, { firstCwd: LINKED, id: 's1', requests: [210, 250] });

  expect(await repositories(db.sql)).toEqual({ s1: MAIN });
});

test('a process on another System does not name a Session repository', async () => {
  await using db = await database();
  await addProcess(db.sql, {
    cwd: LINKED,
    end: 600,
    pid: 100,
    repository: MAIN,
    start: 0,
    system: 'server-1',
  });
  await addSession(db.sql, { firstCwd: LINKED, id: 's1', requests: [3, 200] });

  expect(await repositories(db.sql)).toEqual({ s1: null });
});

test('the Harness process view carries the repository its process reported', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 100, repository: MAIN, start: 0 });
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 101, start: 0 });

  const rows: { pid: number; repository: string | null }[] = await db.sql`
    SELECT pid, repository FROM insight.harness_processes ORDER BY pid
  `;

  expect(rows).toEqual([
    { pid: 100, repository: MAIN },
    { pid: 101, repository: null },
  ]);
});

test('of processes that started at the same time, the one the Hub stored last names the repository', async () => {
  await using db = await database();
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 100, repository: '/work/old', start: 0 });
  await addProcess(db.sql, { cwd: LINKED, end: 600, pid: 101, repository: MAIN, start: 0 });
  await addSession(db.sql, { firstCwd: LINKED, id: 's1', requests: [3, 200] });

  expect(await repositories(db.sql)).toEqual({ s1: MAIN });
});

test('a Session in a working directory as long as a Report allows takes its repository', async () => {
  await using db = await database();
  const cwd = `/${'d'.repeat(4095)}`;
  await addProcess(db.sql, { cwd, end: 600, pid: 100, repository: MAIN, start: 0 });
  await addSession(db.sql, { firstCwd: cwd, id: 's1', requests: [3, 200] });

  expect(await repositories(db.sql)).toEqual({ s1: MAIN });
});
