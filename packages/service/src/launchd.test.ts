import { expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { launchdSupervisor } from './launchd.ts';
import { serviceDefinition } from './names.ts';
import { renderLaunchdPlist } from './plist.ts';
import type { CommandResult } from './runner.ts';
import { SupervisorError, UnitNotInstalledError } from './supervisor.ts';
import { fakeClock, fakeLaunchd, launchctlPrint, tempHome } from './testing.ts';

const LABEL = 'com.dbtlr.heimdall.collector';
const SERVICE = `gui/501/${LABEL}`;
const PRINT = `launchctl print ${SERVICE}`;
const BOOTOUT = `launchctl bootout ${SERVICE}`;
const ENABLE = `launchctl enable ${SERVICE}`;
const KICKSTART_K = `launchctl kickstart -k ${SERVICE}`;
const NO_SESSION = 'no GUI login session; the agent loads when the user logs in';

const failed = (code: number, stderr = ''): CommandResult => ({ code, stderr, stdout: '' });

const collectorDefinition = (home: string, executable = '/opt/heimdall/bin/heimdall-collector') =>
  serviceDefinition({ binary: 'collector', executable, home });

const plistPath = (home: string) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const bootstrapOf = (home: string) => `launchctl bootstrap gui/501 ${plistPath(home)}`;

// The backend for user 501 under `home`, driving `launchd` on `clock`.
const supervisorIn = (home: string, launchd: ReturnType<typeof fakeLaunchd>, clock = fakeClock()) =>
  launchdSupervisor({ ...clock, home, label: LABEL, runner: launchd.runner, uid: 501 });

const withPlist = async (home: string) => {
  const path = plistPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderLaunchdPlist(collectorDefinition(home)));
  return path;
};

// The definition of a newer binary, whose plist differs from `withPlist`'s.
const moved = (home: string) => collectorDefinition(home, '/opt/heimdall/v2/heimdall-collector');

// A runner on a host with no launchctl at all.
const noLaunchctl = () => Promise.reject(new Error('Executable not found in $PATH: "launchctl"'));

// What `promise` rejected with; a test fails when it resolves instead.
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

test('a first install writes the plist, enables it, and bootstraps it, which starts it', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd();

  const outcome = await supervisorIn(home.path, launchd).install(collectorDefinition(home.path));

  expect(outcome).toEqual({ unitWritten: true });
  expect(await readFile(plistPath(home.path), 'utf8')).toBe(
    renderLaunchdPlist(collectorDefinition(home.path)),
  );
  expect(launchd.calls).toEqual([PRINT, ENABLE, bootstrapOf(home.path)]);
});

test('install with a changed plist boots the loaded agent out, waits for it, then writes and bootstraps', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ loaded: true });

  const outcome = await supervisorIn(home.path, launchd).install(moved(home.path));

  expect(outcome).toEqual({ unitWritten: true });
  expect(await readFile(plistPath(home.path), 'utf8')).toBe(renderLaunchdPlist(moved(home.path)));
  expect(launchd.calls).toEqual([PRINT, ENABLE, BOOTOUT, PRINT, bootstrapOf(home.path)]);
});

test('install with an unchanged plist and a loaded agent rewrites and reloads nothing, but restarts it', async () => {
  await using home = await tempHome();
  const path = await withPlist(home.path);
  const before = await stat(path);
  const launchd = fakeLaunchd({ loaded: true });

  const outcome = await supervisorIn(home.path, launchd).install(collectorDefinition(home.path));

  expect(outcome).toEqual({ unitWritten: false });
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect(launchd.calls).toEqual([PRINT, ENABLE, KICKSTART_K]);
});

test('install with an unchanged plist that is not loaded bootstraps it without a bootout', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd();

  const outcome = await supervisorIn(home.path, launchd).install(collectorDefinition(home.path));

  expect(outcome).toEqual({ unitWritten: false });
  expect(launchd.calls).toEqual([PRINT, ENABLE, bootstrapOf(home.path)]);
});

test('install waits for a slow bootout to finish before it bootstraps', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ lingerPrints: 2, loaded: true });

  await supervisorIn(home.path, launchd).install(moved(home.path));

  expect(launchd.calls).toEqual([
    PRINT,
    ENABLE,
    BOOTOUT,
    PRINT,
    PRINT,
    PRINT,
    bootstrapOf(home.path),
  ]);
});

test('install treats a bootout still in progress (exit 36) as under way, and waits for it', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({
    answers: { bootout: [failed(36, 'Boot-out failed: 36: Operation now in progress')] },
    lingerPrints: 1,
    loaded: true,
  });

  await supervisorIn(home.path, launchd).install(moved(home.path));

  expect(launchd.calls).toEqual([PRINT, ENABLE, BOOTOUT, PRINT, PRINT, bootstrapOf(home.path)]);
});

test('install whose bootout fails keeps the old plist, so the next install still sees a change', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({
    answers: { bootout: [failed(1, 'Boot-out failed: 1: Operation not permitted')] },
    loaded: true,
  });

  const error = await rejection(supervisorIn(home.path, launchd).install(moved(home.path)));

  expect(error).toBeInstanceOf(SupervisorError);
  expect((error as Error).message).toBe(
    'launchctl bootout failed (exit 1): Boot-out failed: 1: Operation not permitted',
  );
  expect(await readFile(plistPath(home.path), 'utf8')).toBe(
    renderLaunchdPlist(collectorDefinition(home.path)),
  );
  expect(launchd.calls).not.toContain(bootstrapOf(home.path));
});

test('install gives up on an agent still loaded 15 s after its bootout, and keeps the old plist', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const clock = fakeClock();
  const launchd = fakeLaunchd({ lingerPrints: 1000, loaded: true });

  const error = await rejection(supervisorIn(home.path, launchd, clock).install(moved(home.path)));

  expect(error).toBeInstanceOf(SupervisorError);
  expect((error as Error).message).toBe(`${LABEL} is still loaded 15 s after launchctl bootout`);
  expect(clock.now()).toBeGreaterThanOrEqual(15_000);
  expect(clock.now()).toBeLessThan(16_000);
  expect(await readFile(plistPath(home.path), 'utf8')).toBe(
    renderLaunchdPlist(collectorDefinition(home.path)),
  );
});

test.each([
  [5, 'Bootstrap failed: 5: Input/output error'],
  [37, 'Bootstrap failed: 37: Operation already in progress'],
])('install retries a bootstrap that fails with %i while launchd settles', async (code, said) => {
  await using home = await tempHome();
  const launchd = fakeLaunchd({ answers: { bootstrap: [failed(code, said), failed(code, said)] } });

  await supervisorIn(home.path, launchd).install(collectorDefinition(home.path));

  expect(launchd.calls).toEqual([
    PRINT,
    ENABLE,
    bootstrapOf(home.path),
    bootstrapOf(home.path),
    bootstrapOf(home.path),
  ]);
  expect(launchd.state.loaded).toBe(true);
});

test('install stops retrying a settling bootstrap after about 5 s and says what launchctl said', async () => {
  await using home = await tempHome();
  const clock = fakeClock();
  const launchd = fakeLaunchd({
    answers: {
      bootstrap: Array.from({ length: 1000 }, () =>
        failed(5, 'Bootstrap failed: 5: Input/output error'),
      ),
    },
  });

  const error = await rejection(
    supervisorIn(home.path, launchd, clock).install(collectorDefinition(home.path)),
  );

  expect(error).toBeInstanceOf(SupervisorError);
  expect((error as Error).message).toBe(
    'launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error',
  );
  expect(clock.now()).toBeGreaterThanOrEqual(5000);
  expect(clock.now()).toBeLessThan(6000);
});

test('install surfaces any other bootstrap failure at once', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd({
    answers: { bootstrap: [failed(1, 'Bootstrap failed: 1: Operation not permitted\n')] },
  });

  const error = await rejection(
    supervisorIn(home.path, launchd).install(collectorDefinition(home.path)),
  );

  expect((error as Error).message).toBe(
    'launchctl bootstrap failed (exit 1): Bootstrap failed: 1: Operation not permitted',
  );
  expect(launchd.calls.filter((call) => call.startsWith('launchctl bootstrap'))).toHaveLength(1);
});

test('install on a host without launchctl fails with a supervisor error, not a crash', async () => {
  await using home = await tempHome();

  const error = await rejection(
    launchdSupervisor({ home: home.path, label: LABEL, runner: noLaunchctl, uid: 501 }).install(
      collectorDefinition(home.path),
    ),
  );

  expect(error).toBeInstanceOf(SupervisorError);
  expect((error as Error).message).toContain('launchctl is not available');
});

test('uninstall boots the agent out, waits for it to unload, and removes its plist', async () => {
  await using home = await tempHome();
  const path = await withPlist(home.path);
  const launchd = fakeLaunchd({ loaded: true });

  const outcome = await supervisorIn(home.path, launchd).uninstall();

  expect(outcome).toEqual({ removed: true });
  expect(launchd.calls).toEqual([BOOTOUT, PRINT]);
  expect(await Bun.file(path).exists()).toBe(false);
});

test('uninstall of an agent that is not loaded still removes its plist', async () => {
  await using home = await tempHome();
  const path = await withPlist(home.path);
  const launchd = fakeLaunchd();

  expect(await supervisorIn(home.path, launchd).uninstall()).toEqual({ removed: true });
  expect(launchd.calls).toEqual([BOOTOUT]);
  expect(await Bun.file(path).exists()).toBe(false);
});

test('uninstall keeps the plist when the bootout fails for another reason', async () => {
  await using home = await tempHome();
  const path = await withPlist(home.path);
  const launchd = fakeLaunchd({
    answers: { bootout: [failed(1, 'Boot-out failed: 1')] },
    loaded: true,
  });

  const error = await rejection(supervisorIn(home.path, launchd).uninstall());

  expect(error).toBeInstanceOf(SupervisorError);
  expect(await Bun.file(path).exists()).toBe(true);
});

test('uninstall with no plist asks launchctl nothing', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd();

  expect(await supervisorIn(home.path, launchd).uninstall()).toEqual({ removed: false });
  expect(launchd.calls).toEqual([]);
});

test('stop boots the agent out, because KeepAlive would relaunch a killed process, and waits for it', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ loaded: true });

  await supervisorIn(home.path, launchd).stop();

  expect(launchd.calls).toEqual([BOOTOUT, PRINT]);
  expect(launchd.state.loaded).toBe(false);
});

test('stop of an agent that is already unloaded succeeds', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd();

  await supervisorIn(home.path, launchd).stop();

  expect(launchd.calls).toEqual([BOOTOUT]);
});

test('start bootstraps an unloaded agent, which RunAtLoad then starts', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd();

  await supervisorIn(home.path, launchd).start();

  expect(launchd.calls).toEqual([PRINT, bootstrapOf(home.path)]);
});

test('start of a loaded agent kickstarts it without killing a running process', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ loaded: true });

  await supervisorIn(home.path, launchd).start();

  expect(launchd.calls).toEqual([PRINT, `launchctl kickstart ${SERVICE}`]);
});

test('restart of a loaded agent kills and relaunches it', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ loaded: true });

  await supervisorIn(home.path, launchd).restart();

  expect(launchd.calls).toEqual([PRINT, KICKSTART_K]);
});

test('restart of a stopped agent bootstraps it, which starts it once', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd();

  await supervisorIn(home.path, launchd).restart();

  expect(launchd.calls).toEqual([PRINT, bootstrapOf(home.path)]);
});

test.each(['start', 'stop', 'restart'] as const)(
  '%s with no plist says the agent is not installed and asks launchctl nothing',
  async (verb) => {
    await using home = await tempHome();
    const launchd = fakeLaunchd();

    const error = await rejection(supervisorIn(home.path, launchd)[verb]());

    expect(error).toBeInstanceOf(UnitNotInstalledError);
    expect(launchd.calls).toEqual([]);
  },
);

test('status reads a running agent and its pid from launchctl print, and nothing else', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ loaded: true });

  const status = await supervisorIn(home.path, launchd).status();

  expect(status).toEqual({
    installed: true,
    notes: [],
    running: true,
    stateKnown: true,
    summary: 'loaded, running (pid 4182)',
    unit: plistPath(home.path),
  });
  expect(launchd.calls).toEqual([PRINT]);
});

test('status of a loaded agent that is not running reads stopped', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ answers: { print: [launchctlPrint(LABEL, 'not running')] } });

  const status = await supervisorIn(home.path, launchd).status();

  expect(status).toMatchObject({ running: false, stateKnown: true, summary: 'loaded, stopped' });
});

test('status names any other launchd state as launchd does', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ answers: { print: [launchctlPrint(LABEL, 'spawn scheduled')] } });

  const status = await supervisorIn(home.path, launchd).status();

  expect(status).toMatchObject({ running: false, summary: 'loaded, spawn scheduled' });
});

test('status of an installed agent that is not loaded, such as after stop, reads not loaded, stopped', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd();

  const status = await supervisorIn(home.path, launchd).status();

  expect(status).toMatchObject({
    installed: true,
    notes: [],
    running: false,
    stateKnown: true,
    summary: 'not loaded, stopped',
  });
  expect(launchd.calls).toEqual([PRINT, 'launchctl print gui/501']);
});

test('status notes when the user has no GUI login session for the agent to load into', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({ domain: false });

  const status = await supervisorIn(home.path, launchd).status();

  expect(status).toMatchObject({ notes: [NO_SESSION], summary: 'not loaded, stopped' });
});

test('status adds no session note when the domain cannot be asked', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({
    answers: { 'print-domain': [failed(124, 'timed out after 5 s')] },
  });

  expect((await supervisorIn(home.path, launchd).status()).notes).toEqual([]);
});

test('status with no plist reads not installed and asks launchctl nothing', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd();

  const status = await supervisorIn(home.path, launchd).status();

  expect(status).toEqual({
    installed: false,
    notes: [],
    running: false,
    stateKnown: true,
    summary: 'not installed',
    unit: plistPath(home.path),
  });
  expect(launchd.calls).toEqual([]);
});

test('status reports the state as unknown when launchctl times out', async () => {
  await using home = await tempHome();
  await withPlist(home.path);
  const launchd = fakeLaunchd({
    answers: { print: [failed(124, `launchctl print ${SERVICE} timed out after 5 s`)] },
  });

  const status = await supervisorIn(home.path, launchd).status();

  expect(status).toMatchObject({
    installed: true,
    notes: [],
    running: false,
    stateKnown: false,
    summary: 'state unknown (launchctl print failed (exit 124))',
  });
});

test('status reports the state as unknown when launchctl is missing', async () => {
  await using home = await tempHome();
  await withPlist(home.path);

  const status = await launchdSupervisor({
    home: home.path,
    label: LABEL,
    runner: noLaunchctl,
    uid: 501,
  }).status();

  expect(status).toMatchObject({
    stateKnown: false,
    summary: 'state unknown (launchctl is not available)',
  });
});
