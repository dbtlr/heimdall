import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ServiceRecord } from '@heimdall/schema';
import type { HttpGetResult } from '@heimdall/service';

import { openRecords } from '../records.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { createServiceChecks } from './services-loop.ts';
import { openStopLog } from './stop-log.ts';

const T = Date.parse('2026-10-24T02:00:00Z');
const S = 1000;
const MIN = 60 * S;

const WEB: ServiceRecord = { container: 'web', name: 'web', supervisor: 'docker' };

// A time as the Engine prints it, to the nanosecond, or the zero time it gives
// for a time it does not hold.
const engineTime = (ms: number | null) =>
  ms === null ? '0001-01-01T00:00:00Z' : new Date(ms).toISOString().replace('Z', '123456Z');

// What the Engine holds about a container: its id, when it was created, its
// status, when it last started and finished, the restarts its restart policy
// made, and how its last run ended.
type Container = {
  created?: number;
  exit?: number;
  finished: number | null;
  id?: string;
  oom?: boolean;
  restarts?: number;
  started: number | null;
  status?: string;
};

// The Engine's answer for `docker inspect` of a container, as JSON text.
const inspectedJson = ({
  created = T - 61 * MIN,
  exit = 0,
  finished,
  id = 'a'.repeat(64),
  oom = false,
  restarts = 0,
  started,
  status = 'running',
}: Container) =>
  JSON.stringify({
    Created: engineTime(created),
    Id: id,
    Name: '/web',
    RestartCount: restarts,
    State: {
      Error: '',
      ExitCode: exit,
      FinishedAt: engineTime(finished),
      OOMKilled: oom,
      Paused: status === 'paused',
      Restarting: status === 'restarting',
      Running: ['paused', 'restarting', 'running'].includes(status),
      StartedAt: engineTime(started),
      Status: status,
    },
  });

const answered = (body: string): HttpGetResult => ({
  body,
  kind: 'response',
  status: 200,
  truncated: false,
});

const inspected = (container: Container) => answered(inspectedJson(container));

const REFUSED: HttpGetResult = { kind: 'failed', message: 'refused', reason: 'refused' };

// The Service checks of a Collector that recorded the `web` container, with an
// Engine the test sets through `check` and a clock the test moves.
const setup = async (dir: { path: string }) => {
  const stateDir = join(dir.path, 'state');
  const records = await openRecords({ stateDir });
  records.put('service', WEB);
  records.close();
  let now = T;
  let answer = inspected({ finished: null, started: T - 60 * MIN });
  const stops = await openStopLog({ now: () => now, stateDir });
  const checks = createServiceChecks({
    bootId: () => Promise.resolve('boot-1'),
    docker: { endpoint: { kind: 'unix', path: '/run/user/1000/docker.sock' } },
    findSystemctl: () => Promise.resolve(undefined),
    httpGet: () => Promise.resolve(answer),
    log: { info: () => 0, warn: () => 0 },
    now: () => now,
    open: () => openRecords({ stateDir }),
    stops,
  });
  return {
    // A check one minute after the last, with the Engine answering `next`.
    check: async (next: HttpGetResult) => {
      now += MIN;
      answer = next;
      await checks.tick();
    },
    close: () => {
      checks.close();
      stops.close();
    },
    first: () => checks.tick(),
    latest: () => checks.latest()?.services,
    logged: () => stops.pending().stops,
  };
};

test('a container stopped for about 90 seconds is logged with when it stopped, its exit code, and when it ran again', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    inspected({ exit: 7, finished: T + 10 * S, started: T - 60 * MIN, status: 'exited' }),
  );
  const underWay = c.logged();
  await c.check(inspected({ finished: T + 10 * S, started: T + 100 * S }));
  const ended = c.logged();
  c.close();

  expect(underWay).toEqual([
    {
      exitStatus: 7,
      ongoing: true,
      restarts: 0,
      result: 'exit-code',
      service: 'web',
      startedAt: null,
      stoppedAt: T + 10 * S,
    },
  ]);
  expect(ended).toEqual([
    {
      exitStatus: 7,
      ongoing: false,
      restarts: 0,
      result: 'exit-code',
      service: 'web',
      startedAt: T + 100 * S,
      stoppedAt: T + 10 * S,
    },
  ]);
});

test('a stop that ends between two checks is logged with its times and restarts and no result, which the Engine forgot when the container ran again', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(inspected({ finished: T + 20 * S, restarts: 1, started: T + 21 * S }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: null,
      ongoing: false,
      restarts: 1,
      result: null,
      service: 'web',
      startedAt: T + 21 * S,
      stoppedAt: T + 20 * S,
    },
  ]);
});

test('a container its restart policy keeps restarting is one stop with its restart count while the checks see it restarting', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  const restarting = (finished: number, restarts: number) =>
    inspected({ exit: 1, finished, restarts, started: finished - 2 * S, status: 'restarting' });
  await c.check(restarting(T + 50 * S, 4));
  await c.check(restarting(T + 110 * S, 9));
  await c.check(inspected({ finished: T + 148 * S, restarts: 12, started: T + 150 * S }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: 1,
      ongoing: false,
      restarts: 12,
      result: 'exit-code',
      service: 'web',
      startedAt: T + 150 * S,
      stoppedAt: T + 50 * S,
    },
  ]);
});

test('a container killed for memory is logged as an oom-kill, and one that exited 0 as a success', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    inspected({
      exit: 137,
      finished: T + 10 * S,
      oom: true,
      started: T - 60 * MIN,
      status: 'exited',
    }),
  );
  await c.check(inspected({ finished: T + 10 * S, started: T + 70 * S }));
  await c.check(
    inspected({ exit: 0, finished: T + 130 * S, started: T + 70 * S, status: 'exited' }),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([
    { exitStatus: 137, result: 'oom-kill', stoppedAt: T + 10 * S },
    { exitStatus: 0, ongoing: true, result: 'success', stoppedAt: T + 130 * S },
  ]);
});

test('a container recreated between two checks is one stop from the new container being created to it starting, since the Engine forgets the old one', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    inspected({ created: T + 30 * S, finished: null, id: 'b'.repeat(64), started: T + 31 * S }),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: null,
      ongoing: false,
      restarts: 0,
      result: null,
      service: 'web',
      startedAt: T + 31 * S,
      stoppedAt: T + 30 * S,
    },
  ]);
});

test('a recreated container seen before it starts is a stop under way, with no result, that ends when it runs', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  const created = { created: T + 30 * S, finished: null, id: 'b'.repeat(64) };
  await c.check(inspected({ ...created, started: null, status: 'created' }));
  const underWay = c.logged();
  await c.check(inspected({ ...created, started: T + 90 * S }));
  const ended = c.logged();
  c.close();

  expect(underWay).toEqual([
    {
      exitStatus: null,
      ongoing: true,
      restarts: 0,
      result: null,
      service: 'web',
      startedAt: null,
      stoppedAt: T + 30 * S,
    },
  ]);
  expect(ended).toMatchObject([{ ongoing: false, startedAt: T + 90 * S, stoppedAt: T + 30 * S }]);
});

test('a container seen stopped and then replaced is one stop from the old one stopping to the new one starting', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    inspected({ exit: 143, finished: T + 10 * S, started: T - 60 * MIN, status: 'exited' }),
  );
  await c.check(
    inspected({ created: T + 70 * S, finished: null, id: 'b'.repeat(64), started: T + 71 * S }),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: 143,
      ongoing: false,
      restarts: 0,
      result: 'exit-code',
      service: 'web',
      startedAt: T + 71 * S,
      stoppedAt: T + 10 * S,
    },
  ]);
});

test('a paused container is no stop, since the Engine holds no time for a pause', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(inspected({ finished: null, started: T - 60 * MIN, status: 'paused' }));
  await c.check(inspected({ finished: null, started: T - 60 * MIN }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([]);
});

test('a container first seen stopped is no stop, since there is nothing to compare with', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);

  await c.check(inspected({ exit: 1, finished: T - MIN, started: T - 5 * MIN, status: 'exited' }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([]);
});

test('a check that cannot reach the Engine logs nothing and keeps the baseline, so the stop is found by the next check that can', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(REFUSED);
  const unreachable = c.logged();
  await c.check(inspected({ finished: T + 65 * S, restarts: 1, started: T + 70 * S }));
  const reached = c.logged();
  c.close();

  expect(unreachable).toEqual([]);
  expect(reached).toMatchObject([{ restarts: 1, stoppedAt: T + 65 * S }]);
});

test('a time the Engine gives in another form logs nothing and keeps the baseline, and the container check is unchanged', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    answered(
      inspectedJson({ finished: T + 65 * S, started: T + 70 * S }).replace(
        /"FinishedAt":"[^"]*"/u,
        '"FinishedAt":"soon"',
      ),
    ),
  );
  const unread = c.logged();
  const latest = c.latest();
  await c.check(inspected({ finished: T + 65 * S, started: T + 70 * S }));
  const read = c.logged();
  c.close();

  expect(unread).toEqual([]);
  expect(latest).toMatchObject([{ detail: 'status running', service: 'web', state: 'up' }]);
  expect(read).toMatchObject([{ startedAt: T + 70 * S, stoppedAt: T + 65 * S }]);
});

test('times with an offset, as Podman gives them, are read as the instants they name', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    answered(
      inspectedJson({ finished: T + 65 * S, started: T + 70 * S })
        .replace(/"FinishedAt":"[^"]*"/u, '"FinishedAt":"2026-10-23T22:01:05.5-04:00"')
        .replace(/"StartedAt":"[^"]*"/u, '"StartedAt":"2026-10-24T04:01:10+02:00"'),
    ),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([{ startedAt: T + 70 * S, stoppedAt: T + 65.5 * S }]);
});

test('a time before 1970, as a zero time in another form, is a time the Engine does not hold', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    answered(
      inspectedJson({
        created: T + 30 * S,
        finished: null,
        id: 'b'.repeat(64),
        started: T + 31 * S,
      }).replace(/"FinishedAt":"[^"]*"/u, '"FinishedAt":"0000-12-31T19:03:58-04:56"'),
    ),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([{ startedAt: T + 31 * S, stoppedAt: T + 30 * S }]);
});

test('a container its name points back to is the stop already logged, never a second one with the same time', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  const blue = { created: T - 61 * MIN, finished: null, started: T - 60 * MIN };
  const green = { created: T + 30 * S, finished: null, id: 'b'.repeat(64), started: T + 31 * S };
  await c.first();

  await c.check(inspected(green));
  await c.check(inspected(blue));
  await c.check(inspected(green));
  const logged = c.logged();
  c.close();

  expect(logged.map(({ stoppedAt }) => stoppedAt)).toEqual([T + 30 * S, T - 61 * MIN]);
});

test('a container paused after a stop has run again, so the pause ends the stop', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    inspected({ exit: 1, finished: T + 10 * S, started: T - 60 * MIN, status: 'exited' }),
  );
  await c.check(inspected({ finished: T + 10 * S, started: T + 70 * S, status: 'paused' }));
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([{ ongoing: false, startedAt: T + 70 * S, stoppedAt: T + 10 * S }]);
});

test('a dead container is logged with its exit code, and an exit code the Hub cannot take is unknown', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(
    inspected({ exit: 255, finished: T + 10 * S, started: T - 60 * MIN, status: 'dead' }),
  );
  await c.check(inspected({ finished: T + 10 * S, started: T + 70 * S }));
  await c.check(
    inspected({ exit: 2 ** 31, finished: T + 130 * S, started: T + 70 * S, status: 'exited' }),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([
    { exitStatus: 255, result: 'exit-code', stoppedAt: T + 10 * S },
    { exitStatus: null, result: null, stoppedAt: T + 130 * S },
  ]);
});
