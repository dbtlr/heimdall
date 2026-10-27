import { expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ServiceRecord } from '@heimdall/schema';

import { openRecords } from '../records.ts';
import type { CommandResult } from '../subprocess.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { createServiceChecks } from './services-loop.ts';
import { openStopLog } from './stop-log.ts';

const T = Date.parse('2026-10-24T02:00:00Z');
const S = 1000;
const MIN = 60 * S;

const PROXY: ServiceRecord = { name: 'proxy', supervisor: 'systemd', unit: 'proxy.service' };

// A time as `systemctl show --timestamp=us+utc` prints it.
const shownTime = (ms: number | null) => {
  if (ms === null) {
    return '';
  }
  const weekday = new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
  const [date, time] = new Date(ms).toISOString().replace('Z', '').split('T');
  return `${weekday} ${date ?? ''} ${time ?? ''}123 UTC`;
};

// What systemd holds about a unit: whether it is running, when it last entered
// and left its running state, its automatic restarts, and how its last run
// ended.
type Unit = {
  active?: string;
  enter: number | null;
  exit: number | null;
  restarts?: number;
  result?: string;
  status?: number;
};

const shown = ({
  active = 'active',
  enter,
  exit,
  restarts = 0,
  result = 'success',
  status = 0,
}: Unit): CommandResult => ({
  exitCode: 0,
  kind: 'exited',
  stderr: '',
  stdout: [
    `Result=${result}`,
    `NRestarts=${String(restarts)}`,
    `ExecMainStatus=${String(status)}`,
    'LoadState=loaded',
    `ActiveState=${active}`,
    `SubState=${active === 'active' ? 'running' : 'auto-restart'}`,
    `ActiveEnterTimestamp=${shownTime(enter)}`,
    `ActiveExitTimestamp=${shownTime(exit)}`,
    '',
  ].join('\n'),
});

const BUS_DOWN: CommandResult = {
  exitCode: 1,
  kind: 'exited',
  stderr: 'Failed to connect to bus: No such file or directory',
  stdout: '',
};

// The Service checks of a Collector that recorded the proxy, in `dir`, with a
// systemd the test sets through `check`, a boot the test sets through `reboot`,
// and a clock the test moves. `restart` stands for the Collector restarting:
// the checks and the stop log are opened again over the same state, and
// `forget` for the provisioner forgetting the proxy's record.
const setup = async (dir: { path: string }) => {
  const stateDir = join(dir.path, 'state');
  const records = await openRecords({ stateDir });
  records.put('service', PROXY);
  records.close();
  let now = T;
  const system: { answer: CommandResult; boot: string | undefined } = {
    answer: shown({ enter: T - 60 * MIN, exit: null }),
    boot: 'boot-1',
  };
  const open = async () => {
    const stops = await openStopLog({ now: () => now, stateDir });
    const checks = createServiceChecks({
      bootId: () => Promise.resolve(system.boot),
      findSystemctl: () => Promise.resolve('/usr/bin/systemctl'),
      log: { info: () => 0, warn: () => 0 },
      now: () => now,
      open: () => openRecords({ stateDir }),
      run: () => Promise.resolve(system.answer),
      stops,
    });
    return { checks, stops };
  };
  let held = await open();
  return {
    // A check one minute after the last, with systemd answering `answer`.
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
    forget: async () => {
      const store = await openRecords({ stateDir });
      store.forget('service', 'proxy');
      store.close();
    },
    logged: () => held.stops.pending().stops,
    reboot: (boot: string | undefined) => {
      system.boot = boot;
    },
    restart: async () => {
      held.checks.close();
      held.stops.close();
      held = await open();
    },
  };
};

test('a stop of about 87 seconds is logged with when it stopped, how it ended, and when it ran again', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  // Stopped 10 s after the first check, and waiting to restart at the next.
  await c.check(
    shown({
      active: 'activating',
      enter: T - 60 * MIN,
      exit: T + 10 * S,
      result: 'exit-code',
      status: 3,
    }),
  );
  const underWay = c.logged();
  // Ran again 87 s after it stopped.
  await c.check(shown({ enter: T + 97 * S, exit: T + 10 * S, restarts: 1 }));
  const ended = c.logged();
  c.close();

  expect(underWay).toEqual([
    {
      exitStatus: 3,
      ongoing: true,
      restarts: 0,
      result: 'exit-code',
      service: 'proxy',
      startedAt: null,
      stoppedAt: T + 10 * S,
    },
  ]);
  expect(ended).toEqual([
    {
      exitStatus: 3,
      ongoing: false,
      restarts: 1,
      result: 'exit-code',
      service: 'proxy',
      startedAt: T + 97 * S,
      stoppedAt: T + 10 * S,
    },
  ]);
});

test('a stop that ends between two checks is logged with its times and no result, which systemd forgot when the Service ran again', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(shown({ enter: T + 40 * S, exit: T + 20 * S }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: null,
      ongoing: false,
      restarts: 0,
      result: null,
      service: 'proxy',
      startedAt: T + 40 * S,
      stoppedAt: T + 20 * S,
    },
  ]);
});

test('a restart storm is one stop with its restart count while the checks see the Service stopped', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  const failing = (exit: number, restarts: number) =>
    shown({
      active: 'activating',
      enter: exit - 2 * S,
      exit,
      restarts,
      result: 'exit-code',
      status: 1,
    });
  await c.check(failing(T + 50 * S, 4));
  await c.check(failing(T + 110 * S, 9));
  await c.check(shown({ enter: T + 150 * S, exit: T + 148 * S, restarts: 12 }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: 1,
      ongoing: false,
      restarts: 12,
      result: 'exit-code',
      service: 'proxy',
      startedAt: T + 150 * S,
      stoppedAt: T + 50 * S,
    },
  ]);
});

test('a Collector restarted within one boot finds a stop that happened while it was down', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.restart();
  await c.check(shown({ enter: T + 30 * S, exit: T + 25 * S, restarts: 1 }));
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([{ restarts: 1, startedAt: T + 30 * S, stoppedAt: T + 25 * S }]);
});

test('a lower restart count, as after reset-failed, is no stop, and later restarts count from it', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.check(shown({ enter: T - 5 * MIN, exit: T - 6 * MIN, restarts: 4 }));

  await c.check(shown({ enter: T - 5 * MIN, exit: T - 6 * MIN, restarts: 0 }));
  const afterReset = c.logged();
  await c.check(shown({ enter: T + 3 * MIN, exit: T + 2.5 * MIN, restarts: 1 }));
  const afterRestart = c.logged();
  c.close();

  expect(afterReset).toEqual([]);
  expect(afterRestart).toMatchObject([{ restarts: 1, stoppedAt: T + 2.5 * MIN }]);
});

test('a check that cannot reach systemd logs nothing and keeps the baseline, so the stop is found by the next check that can', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(BUS_DOWN);
  const unreachable = c.logged();
  await c.check(shown({ enter: T + 70 * S, exit: T + 65 * S, restarts: 1 }));
  const reached = c.logged();
  c.close();

  expect(unreachable).toEqual([]);
  expect(reached).toMatchObject([{ restarts: 1, stoppedAt: T + 65 * S }]);
});

test('a Service first seen stopped is no stop, since there is nothing to compare with', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);

  await c.check(
    shown({ active: 'failed', enter: T - 5 * MIN, exit: T - MIN, result: 'exit-code', status: 1 }),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([]);
});

test('a reboot is no stop, and a stop still under way before it ends with no known end', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();
  await c.check(
    shown({ active: 'failed', enter: T - 60 * MIN, exit: T + 30 * S, result: 'signal', status: 9 }),
  );

  c.reboot('boot-2');
  await c.check(shown({ enter: T + 3 * MIN, exit: null }));
  const logged = c.logged();
  c.close();

  expect(logged).toEqual([
    {
      exitStatus: 9,
      ongoing: false,
      restarts: 0,
      result: 'signal',
      service: 'proxy',
      startedAt: null,
      stoppedAt: T + 30 * S,
    },
  ]);
});

test('a storm that is running at each check is one stop per check, each with its own restarts', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(shown({ enter: T + 59 * S, exit: T + 58 * S, restarts: 20 }));
  await c.check(shown({ enter: T + 119 * S, exit: T + 118 * S, restarts: 41 }));
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([
    { restarts: 20, result: null, startedAt: T + 59 * S, stoppedAt: T + 58 * S },
    { restarts: 21, result: null, startedAt: T + 119 * S, stoppedAt: T + 118 * S },
  ]);
});

test('forgetting a Service ends its stop under way with no known end', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();
  await c.check(
    shown({
      active: 'failed',
      enter: T - 60 * MIN,
      exit: T + 30 * S,
      result: 'exit-code',
      status: 1,
    }),
  );

  await c.forget();
  await c.check(
    shown({
      active: 'failed',
      enter: T - 60 * MIN,
      exit: T + 30 * S,
      result: 'exit-code',
      status: 1,
    }),
  );
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([{ ongoing: false, startedAt: null, stoppedAt: T + 30 * S }]);
});

const failing = () => {
  throw new Error('database or disk is full');
};

test('a stop log that fails costs the stops, never the Service checks, and is warned about once', async () => {
  await using dir = await tempStateDir();
  const stateDir = join(dir.path, 'state');
  const records = await openRecords({ stateDir });
  records.put('service', PROXY);
  records.close();
  const warnings: string[] = [];
  const checks = createServiceChecks({
    bootId: () => Promise.resolve('boot-1'),
    findSystemctl: () => Promise.resolve('/usr/bin/systemctl'),
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    now: () => T,
    open: () => openRecords({ stateDir }),
    run: () => Promise.resolve(shown({ enter: T - MIN, exit: null })),
    stops: { close: () => {}, observe: failing, pending: failing, retain: failing },
  });

  await checks.tick();
  await checks.tick();
  checks.close();

  expect(checks.latest()?.services).toMatchObject([{ service: 'proxy', state: 'up' }]);
  expect(warnings).toEqual([
    expect.stringContaining('Could not log Service stops: database or disk is full'),
  ]);
});

test('a boot that cannot be read logs nothing, and the Service checks go on', async () => {
  await using dir = await tempStateDir();
  const stateDir = join(dir.path, 'state');
  const records = await openRecords({ stateDir });
  records.put('service', PROXY);
  records.close();
  const stops = await openStopLog({ stateDir });
  let answer = shown({ enter: T - MIN, exit: null });
  const checks = createServiceChecks({
    bootId: () => Promise.reject(new Error('sysctl exited 1')),
    findSystemctl: () => Promise.resolve('/usr/bin/systemctl'),
    log: { info: () => 0, warn: () => 0 },
    now: () => T,
    open: () => openRecords({ stateDir }),
    run: () => Promise.resolve(answer),
    stops,
  });

  await checks.tick();
  answer = shown({ enter: T + 30 * S, exit: T + 20 * S, restarts: 1 });
  await checks.tick();
  const logged = stops.pending().stops;
  checks.close();
  stops.close();

  expect(logged).toEqual([]);
  expect(checks.latest()?.services).toMatchObject([{ service: 'proxy', state: 'up' }]);
});

test('a restart count past what the Hub takes is sent as the most it takes', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.first();

  await c.check(shown({ enter: T + 40 * S, exit: T + 20 * S, restarts: 4_000_000_000 }));
  const logged = c.logged();
  c.close();

  expect(logged).toMatchObject([{ restarts: 2_147_483_647 }]);
});
