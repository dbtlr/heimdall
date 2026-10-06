import { expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { serviceDefinition } from './names.ts';
import type { CommandResult } from './runner.ts';
import { SupervisorError, UnitNotInstalledError } from './supervisor.ts';
import { systemdSupervisor } from './systemd.ts';
import { tempHome } from './testing.ts';
import { renderSystemdUnit } from './unit.ts';

const UNIT = 'com.dbtlr.heimdall.hub.service';
const ok = (stdout = ''): CommandResult => ({ code: 0, stderr: '', stdout });

// A command runner that records every command and answers from `answer`,
// which sees the command and returns its result. Nothing reaches a real systemctl.
const fakeRunner = (answer: (argv: readonly string[]) => CommandResult = () => ok()) => {
  const calls: string[] = [];
  return {
    calls,
    runner: async (argv: readonly string[]) => {
      calls.push(argv.join(' '));
      return answer(argv);
    },
  };
};

const hubDefinition = (home: string, executable = '/opt/heimdall/heimdall-hub') =>
  serviceDefinition({ binary: 'hub', executable, home });

const supervisorIn = (home: string, runner: ReturnType<typeof fakeRunner>['runner']) =>
  systemdSupervisor({ home, label: 'com.dbtlr.heimdall.hub', runner, user: '1000' });

const unitPath = (home: string) => join(home, '.config', 'systemd', 'user', UNIT);

// A runner on a host with no systemctl or loginctl at all.
const noManager = () => Promise.reject(new Error('Executable not found in $PATH: "systemctl"'));

// What `promise` rejected with; a test fails when it resolves instead.
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

test('install writes the unit, reloads the manager, enables it, and restarts it', async () => {
  await using home = await tempHome();
  const fake = fakeRunner();

  const outcome = await supervisorIn(home.path, fake.runner).install(hubDefinition(home.path));

  expect(outcome).toEqual({ unitWritten: true });
  expect(await readFile(unitPath(home.path), 'utf8')).toBe(
    renderSystemdUnit(hubDefinition(home.path)),
  );
  expect(fake.calls).toEqual([
    'systemctl --user daemon-reload',
    `systemctl --user enable ${UNIT}`,
    `systemctl --user restart ${UNIT}`,
  ]);
});

test('install with an unchanged unit rewrites nothing and reloads nothing, but still restarts', async () => {
  await using home = await tempHome();
  await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));
  const before = await stat(unitPath(home.path));
  const fake = fakeRunner();

  const outcome = await supervisorIn(home.path, fake.runner).install(hubDefinition(home.path));

  expect(outcome).toEqual({ unitWritten: false });
  expect((await stat(unitPath(home.path))).mtimeMs).toBe(before.mtimeMs);
  expect(fake.calls).toEqual([
    `systemctl --user show ${UNIT} --property=NeedDaemonReload`,
    `systemctl --user enable ${UNIT}`,
    `systemctl --user restart ${UNIT}`,
  ]);
});

test('install with a changed unit rewrites it and reloads before restarting', async () => {
  await using home = await tempHome();
  await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));
  const fake = fakeRunner();
  const moved = hubDefinition(home.path, '/opt/heimdall-0.2.0/heimdall-hub');

  const outcome = await supervisorIn(home.path, fake.runner).install(moved);

  expect(outcome).toEqual({ unitWritten: true });
  expect(await readFile(unitPath(home.path), 'utf8')).toContain('/opt/heimdall-0.2.0/heimdall-hub');
  expect(fake.calls).toEqual([
    'systemctl --user daemon-reload',
    `systemctl --user enable ${UNIT}`,
    `systemctl --user restart ${UNIT}`,
  ]);
});

test('a failing systemctl command fails install with its message', async () => {
  await using home = await tempHome();
  const fake = fakeRunner((argv) =>
    argv[2] === 'restart'
      ? { code: 1, stderr: 'Job for com.dbtlr.heimdall.hub.service failed.\n', stdout: '' }
      : ok(),
  );

  const error = await rejection(
    supervisorIn(home.path, fake.runner).install(hubDefinition(home.path)),
  );

  expect(error).toBeInstanceOf(SupervisorError);
  expect(error).toHaveProperty(
    'message',
    'systemctl --user restart failed (exit 1): Job for com.dbtlr.heimdall.hub.service failed.',
  );
});

test('a missing systemctl fails install with a message rather than a crash', async () => {
  await using home = await tempHome();
  const error = await rejection(
    supervisorIn(home.path, noManager).install(hubDefinition(home.path)),
  );

  expect(String(error)).toContain('systemctl is not available');
});

test('uninstall stops and disables the unit, removes its file, and reloads, keeping logs and config', async () => {
  await using home = await tempHome();
  await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));
  const log = join(home.path, '.local', 'state', 'heimdall', 'hub.log');
  const config = join(home.path, '.config', 'heimdall', 'hub.toml');
  await mkdir(join(home.path, '.local', 'state', 'heimdall'), { recursive: true });
  await mkdir(join(home.path, '.config', 'heimdall'), { recursive: true });
  await writeFile(log, 'a log line\n');
  await writeFile(config, 'port = 8080\n');
  const fake = fakeRunner();
  let unitPresentAtDisable = false;
  const watching = async (argv: readonly string[]) => {
    if (argv[2] === 'disable') {
      unitPresentAtDisable = await Bun.file(unitPath(home.path)).exists();
    }
    return fake.runner(argv);
  };

  const outcome = await supervisorIn(home.path, watching).uninstall();

  expect(outcome).toEqual({ removed: true });
  expect(fake.calls).toEqual([
    `systemctl --user stop ${UNIT}`,
    `systemctl --user disable ${UNIT}`,
    'systemctl --user daemon-reload',
  ]);
  expect(unitPresentAtDisable).toBe(true);
  expect(await Bun.file(unitPath(home.path)).exists()).toBe(false);
  expect(await readFile(log, 'utf8')).toBe('a log line\n');
  expect(await readFile(config, 'utf8')).toBe('port = 8080\n');
});

test('uninstall with no unit installed does nothing', async () => {
  await using home = await tempHome();
  const fake = fakeRunner();

  const outcome = await supervisorIn(home.path, fake.runner).uninstall();

  expect(outcome).toEqual({ removed: false });
  expect(fake.calls).toEqual([]);
});

test.each(['start', 'stop', 'restart'] as const)(
  '%s runs the matching systemctl command on the installed unit',
  async (verb) => {
    await using home = await tempHome();
    await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));
    const fake = fakeRunner();

    await supervisorIn(home.path, fake.runner)[verb]();

    expect(fake.calls).toEqual([`systemctl --user ${verb} ${UNIT}`]);
  },
);

test.each(['start', 'stop', 'restart'] as const)(
  '%s with no unit installed fails without calling systemctl',
  async (verb) => {
    await using home = await tempHome();
    const fake = fakeRunner();

    const error = await rejection(supervisorIn(home.path, fake.runner)[verb]());

    expect(error).toBeInstanceOf(UnitNotInstalledError);
    expect(fake.calls).toEqual([]);
  },
);

// The answers of a manager whose unit is in `show` state and whose user has `linger`.
const manager =
  ({ linger = 'yes', show }: { linger?: string; show: string }) =>
  (argv: readonly string[]) =>
    argv[0] === 'loginctl' ? ok(`Linger=${linger}\n`) : ok(show);

test('status of a running unit names its pid', async () => {
  await using home = await tempHome();
  await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));
  const fake = fakeRunner(
    manager({ show: 'MainPID=4182\nLoadState=loaded\nActiveState=active\nSubState=running\n' }),
  );

  const status = await supervisorIn(home.path, fake.runner).status();

  expect(status).toEqual({
    installed: true,
    notes: [],
    running: true,
    stateKnown: true,
    summary: 'loaded, running (pid 4182)',
    unit: unitPath(home.path),
  });
  expect(fake.calls).toEqual([
    `systemctl --user show ${UNIT} --property=LoadState,ActiveState,SubState,MainPID`,
    'loginctl show-user 1000 --property=Linger',
  ]);
});

test.each([
  ['MainPID=0\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n', 'loaded, stopped'],
  ['MainPID=0\nLoadState=loaded\nActiveState=failed\nSubState=failed\n', 'loaded, failed'],
  [
    'MainPID=0\nLoadState=loaded\nActiveState=activating\nSubState=auto-restart\n',
    'loaded, activating (auto-restart)',
  ],
  ['MainPID=0\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n', 'not-found, stopped'],
])('status reads the manager state %#', async (show, summary) => {
  await using home = await tempHome();
  await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));

  const status = await supervisorIn(home.path, fakeRunner(manager({ show })).runner).status();

  expect(status.summary).toBe(summary);
  expect(status.running).toBe(false);
});

test('status with no unit installed says so without asking systemctl', async () => {
  await using home = await tempHome();
  const fake = fakeRunner(manager({ show: '' }));

  const status = await supervisorIn(home.path, fake.runner).status();

  expect(status).toEqual({
    installed: false,
    notes: [],
    running: false,
    stateKnown: true,
    summary: 'not installed',
    unit: unitPath(home.path),
  });
  expect(fake.calls).toEqual(['loginctl show-user 1000 --property=Linger']);
});

test('status notes when linger is off, and never turns it on', async () => {
  await using home = await tempHome();
  const fake = fakeRunner(manager({ linger: 'no', show: '' }));

  const status = await supervisorIn(home.path, fake.runner).status();

  expect(status.notes).toEqual(['linger is off; the unit stops at logout']);
  expect(fake.calls.filter((call) => call.includes('enable-linger'))).toEqual([]);
});

test('status reports an unreachable manager as an unknown state rather than failing', async () => {
  await using home = await tempHome();
  await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));
  const status = await supervisorIn(home.path, noManager).status();

  expect(status.installed).toBe(true);
  expect(status.running).toBe(false);
  expect(status.stateKnown).toBe(false);
  expect(status.summary).toBe('state unknown (systemctl is not available)');
  expect(status.notes).toEqual([]);
});

test('install reloads an unchanged unit the manager says needs a reload', async () => {
  await using home = await tempHome();
  await supervisorIn(home.path, fakeRunner().runner).install(hubDefinition(home.path));
  const fake = fakeRunner((argv) =>
    argv.includes('--property=NeedDaemonReload') ? ok('NeedDaemonReload=yes\n') : ok(),
  );

  const outcome = await supervisorIn(home.path, fake.runner).install(hubDefinition(home.path));

  expect(outcome).toEqual({ unitWritten: false });
  expect(fake.calls).toEqual([
    `systemctl --user show ${UNIT} --property=NeedDaemonReload`,
    'systemctl --user daemon-reload',
    `systemctl --user enable ${UNIT}`,
    `systemctl --user restart ${UNIT}`,
  ]);
});
