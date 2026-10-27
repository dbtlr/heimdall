import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ServiceRecord } from '@heimdall/schema';
import { NOT_FOUND_IN_GUI, NOT_RUNNING_AGENT, RUNNING_AGENT } from '@heimdall/service/testing';

import { openRecords } from '../records.ts';
import type { CommandResult } from '../subprocess.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { createServiceChecks } from './services-loop.ts';
import { openStopLog } from './stop-log.ts';

const T = Date.parse('2026-10-24T02:00:00Z');
const S = 1000;
const MIN = 60 * S;

const PROXY: ServiceRecord = { label: 'com.example.proxy', name: 'proxy', supervisor: 'launchd' };

// What launchd holds about a label: its runs, the pid of its process while one
// runs, and how its last run ended, as launchctl prints them.
type Agent = { exit?: string; pid?: number; runs: number; signal?: string };

// `launchctl print` of the label, built from the captures: the running agent
// with its pid, or the loaded agent with no process, with the agent's runs and
// last exit in place of the captured ones.
const printed = ({ exit = '(never exited)', pid, runs, signal }: Agent): CommandResult => {
  const capture =
    pid === undefined
      ? NOT_RUNNING_AGENT
      : RUNNING_AGENT.replace('\tpid = 59099', `\tpid = ${String(pid)}`);
  const lastExit = [
    `\tlast exit code = ${exit}`,
    ...(signal === undefined ? [] : [`\tlast terminating signal = ${signal}`]),
  ].join('\n');
  return {
    exitCode: 0,
    kind: 'exited',
    stderr: '',
    stdout: capture
      .replace(/\truns = \d+/u, `\truns = ${String(runs)}`)
      .replace(/\tlast exit code = .*/u, lastExit),
  };
};

// A running agent for which launchctl printed its state but no pid.
const runningWithoutPid = (runs: number): CommandResult => ({
  exitCode: 0,
  kind: 'exited',
  stderr: '',
  stdout: RUNNING_AGENT.replace('\tpid = 59099\n', '').replace(
    /\truns = \d+/u,
    `\truns = ${String(runs)}`,
  ),
});

const NOT_LOADED: CommandResult = {
  exitCode: 113,
  kind: 'exited',
  stderr: NOT_FOUND_IN_GUI,
  stdout: '',
};
const TIMED_OUT: CommandResult = { kind: 'timed out' };

// The Service checks of a Collector that recorded the proxy agent, with a
// launchd the test sets through `check`, which answers for the account's GUI
// domain and has nothing in the system domain, and a clock the test moves, and
// launchctl moves by `launchctlTakes` for each answer.
// `restart` stands for the Collector restarting over the same state.
const setup = async (dir: { path: string }, { launchctlTakes = 0 } = {}) => {
  const stateDir = join(dir.path, 'state');
  const records = await openRecords({ stateDir });
  records.put('service', PROXY);
  records.close();
  let now = T;
  const system: { answer: CommandResult; boot: string } = {
    answer: printed({ pid: 500, runs: 1 }),
    boot: 'boot-1',
  };
  const open = async () => {
    const stops = await openStopLog({ now: () => now, stateDir });
    const checks = createServiceChecks({
      bootId: () => Promise.resolve(system.boot),
      findSystemctl: () => Promise.resolve(undefined),
      log: { info: () => 0, warn: () => 0 },
      now: () => now,
      open: () => openRecords({ stateDir }),
      // launchctl answers once `launchctlTakes` has passed on the clock.
      run: (cmd) => {
        now += launchctlTakes;
        return Promise.resolve((cmd.at(-1) ?? '').startsWith('gui/') ? system.answer : NOT_LOADED);
      },
      stops,
    });
    return { checks, stops };
  };
  let held = await open();
  return {
    // A check one minute after the last, with launchd answering `answer`.
    check: async (answer: CommandResult) => {
      now += MIN;
      system.answer = answer;
      await held.checks.tick();
    },
    close: () => {
      held.checks.close();
      held.stops.close();
    },
    first: () => held.checks.tick(),
    latest: () => held.checks.latest()?.services,
    logged: () => held.stops.pending().stops,
    reboot: (boot: string) => {
      system.boot = boot;
    },
    restart: async () => {
      held.checks.close();
      held.stops.close();
      held = await open();
    },
  };
};

test('an agent that exits and is started again between two checks is a stop from the check before to the check after, with how it exited', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(printed({ exit: '1', pid: 600, runs: 2 }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: 1,
      ongoing: false,
      restarts: 1,
      result: 'exit-code',
      service: 'proxy',
      startedAt: T + MIN,
      stoppedAt: T,
    },
  ]);
});

test('an agent seen with no process is a stop under way from the check before, which the check that sees it running again ends', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(printed({ exit: '78', runs: 1 }));
  const underWay = c.logged();
  await c.check(printed({ exit: '78', pid: 700, runs: 2 }));
  const ended = c.logged();
  c.close();

  expect(underWay).toEqual([
    {
      exitStatus: 78,
      ongoing: true,
      restarts: 0,
      result: 'exit-code',
      service: 'proxy',
      startedAt: null,
      stoppedAt: T,
    },
  ]);
  expect(ended).toEqual([
    {
      exitStatus: 78,
      ongoing: false,
      restarts: 1,
      result: 'exit-code',
      service: 'proxy',
      startedAt: T + 2 * MIN,
      stoppedAt: T,
    },
  ]);
});

test('an agent launchd keeps starting is one stop with its runs while the checks see it with no process', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(printed({ exit: '1', runs: 4 }));
  await c.check(printed({ exit: '1', runs: 9 }));
  await c.check(printed({ exit: '1', pid: 800, runs: 10 }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: 1,
      ongoing: false,
      restarts: 9,
      result: 'exit-code',
      service: 'proxy',
      startedAt: T + 3 * MIN,
      stoppedAt: T,
    },
  ]);
});

test('an agent loaded again, which starts its runs over, is a stop by its new process', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.check(printed({ pid: 500, runs: 6 }));

  await c.check(printed({ pid: 900, runs: 1 }));
  const reloaded = c.logged();
  await c.check(printed({ pid: 900, runs: 1 }));
  const after = c.logged();
  c.close();

  expect(reloaded).toEqual([
    {
      exitStatus: null,
      ongoing: false,
      restarts: 0,
      result: null,
      service: 'proxy',
      startedAt: T + 2 * MIN,
      stoppedAt: T + MIN,
    },
  ]);
  expect(after).toEqual(reloaded);
});

test('an agent unloaded and loaded again is one stop from the check before it was unloaded to the check that sees it running', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(NOT_LOADED);
  const unloaded = c.logged();
  await c.check(printed({ pid: 900, runs: 1 }));
  const loaded = c.logged();
  c.close();

  expect(unloaded).toMatchObject([{ ongoing: true, startedAt: null, stoppedAt: T }]);
  expect(loaded).toMatchObject([{ ongoing: false, startedAt: T + 2 * MIN, stoppedAt: T }]);
  expect(c.latest()).toMatchObject([{ state: 'up' }]);
});

test('an agent running the same process at each check is no stop', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(printed({ pid: 500, runs: 1 }));
  await c.check(printed({ pid: 500, runs: 1 }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([]);
});

test('an agent first seen with no process is no stop, and neither is its start', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.check(printed({ exit: '1', runs: 3 }));

  await c.check(printed({ exit: '1', pid: 500, runs: 4 }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([]);
});

test('an agent that ran and exited again between two checks that saw it with no process is a stop', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.check(printed({ exit: '1', runs: 3 }));

  await c.check(printed({ exit: '2', runs: 4 }));
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([
    { exitStatus: 2, ongoing: true, restarts: 1, result: 'exit-code', stoppedAt: T + MIN },
  ]);
});

test('a lower run count with the same process is no stop, and later runs count from it', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.check(printed({ pid: 500, runs: 6 }));

  await c.check(printed({ pid: 500, runs: 2 }));
  const lowered = c.logged();
  await c.check(printed({ exit: '1', pid: 600, runs: 3 }));
  const restarted = c.logged();
  c.close();

  expect(lowered).toEqual([]);
  expect(restarted).toMatchObject([{ restarts: 1, stoppedAt: T + 2 * MIN }]);
});

test('a check that cannot reach launchd logs nothing and keeps the baseline, so the stop is timed from the last check that reached it', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(TIMED_OUT);
  const unreachable = c.logged();
  await c.check(printed({ exit: '1', pid: 600, runs: 2 }));
  const reached = c.logged();
  c.close();

  expect(unreachable).toEqual([]);
  expect(reached).toMatchObject([{ restarts: 1, startedAt: T + 2 * MIN, stoppedAt: T }]);
});

test('a stop is timed from when the check before began, so a slow launchctl never times it after it happened', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir, { launchctlTakes: 8 * S });
  await c.first();

  await c.check(printed({ exit: '1', pid: 600, runs: 2 }));
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([{ startedAt: T + 8 * S + MIN + 8 * S, stoppedAt: T }]);
});

test('an agent first printed without a pid and then with one is the same run, not a stop', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.check(runningWithoutPid(1));

  await c.check(printed({ pid: 500, runs: 1 }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([]);
});

test('a stop under way that ends takes how the last run ended, which launchd still holds', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(printed({ exit: '1', runs: 1 }));
  await c.check(printed({ exit: '2', pid: 600, runs: 3 }));
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([
    { exitStatus: 2, ongoing: false, restarts: 2, result: 'exit-code' },
  ]);
});
