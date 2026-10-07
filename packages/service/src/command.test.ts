import { expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { Application } from '@loomcli/core';
import { config } from '@loomcli/plugins/config';

import { serviceCommand } from './command.ts';
import type { ServiceEnvironment, ServiceSpec } from './command.ts';
import { platformSupervisor } from './platform.ts';
import { fakeLaunchd, fakeSupervisor, tempHome } from './testing.ts';

const HUB: ServiceSpec = { binary: 'hub', version: '0.2.0' };
const EXECUTABLE = '/opt/heimdall/bin/heimdall-hub';

// The state directories the Collector's status asked to count, in order.
const waiting: string[] = [];
const COLLECTOR: ServiceSpec = {
  binary: 'collector',
  defaultStateDir: ({ home }) => join(home, 'default-state'),
  queueDepth: (stateDir) => {
    waiting.push(stateDir);
    return Promise.resolve(stateDir.endsWith('empty') ? undefined : 12);
  },
  version: '0.2.0',
};

type Fake = ReturnType<typeof fakeSupervisor>;

// Runs `heimdall-<binary> service …` in-process against a fake supervisor, with
// `home` as HOME and the working directory, and captures what it prints.
const invoke = async (
  spec: ServiceSpec,
  argv: string[],
  {
    env = {},
    environment = {},
    fake = fakeSupervisor(),
    home,
  }: {
    env?: Record<string, string>;
    environment?: Partial<ServiceEnvironment>;
    fake?: Fake;
    home: string;
  },
) => {
  const app = new Application(`heimdall-${spec.binary}`, {
    plugins: [config({ file: `.config/heimdall/${spec.binary}.{toml,json}` })],
  }).command(
    serviceCommand(spec, {
      compiled: () => true,
      executable: EXECUTABLE,
      fetch: () => Promise.reject(new Error('no Hub in this test')),
      platform: 'linux',
      supervisor: () => fake.supervisor,
      ...environment,
    }),
  );
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({
      host: { argv, cwd: home, env: { HOME: home, ...env }, stderr, stdout },
    });
  } finally {
    process.exitCode = runnerExitCode;
  }
  stdout.end();
  stderr.end();
  return { calls: fake.calls, code, stderr: await text(stderr), stdout: await text(stdout) };
};

const healthy = (version: string, seen: string[] = []) => ({
  fetch: (url: string) => {
    seen.push(url);
    return Promise.resolve(Response.json({ database: 'ok', version }));
  },
});

test('install refuses to touch the supervisor from a binary that is not compiled', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'install', '--port', '9090'], {
    environment: { compiled: () => false },
    home: home.path,
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('not a compiled binary');
  expect(result.calls).toEqual([]);
  expect(await Bun.file(join(home.path, '.config', 'heimdall', 'hub.toml')).exists()).toBe(false);
  expect(await Bun.file(join(home.path, '.local')).exists()).toBe(false);
});

test('uninstall refuses from a binary that is not compiled', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'uninstall'], {
    environment: { compiled: () => false },
    fake: fakeSupervisor({ installed: true }),
    home: home.path,
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('not a compiled binary');
  expect(result.calls).toEqual([]);
});

test('install creates the log directory and installs a unit that runs serve from home', async () => {
  await using home = await tempHome();
  const fake = fakeSupervisor();

  const result = await invoke(HUB, ['service', 'install'], { fake, home: home.path });

  expect(result.code).toBe(0);
  expect((await stat(join(home.path, '.local', 'state', 'heimdall'))).isDirectory()).toBe(true);
  expect(fake.calls).toEqual(['install']);
  expect(fake.state.definition).toEqual({
    arguments: ['serve'],
    description: 'Heimdall Hub (com.dbtlr.heimdall.hub)',
    executable: EXECUTABLE,
    label: 'com.dbtlr.heimdall.hub',
    log: join(home.path, '.local', 'state', 'heimdall', 'hub.log'),
    workingDirectory: home.path,
  });
  expect(result.stdout).toContain('Restarted com.dbtlr.heimdall.hub');
  expect(await Bun.file(join(home.path, '.config', 'heimdall', 'hub.toml')).exists()).toBe(false);
});

test('install again with nothing changed says the unit is unchanged and still restarts', async () => {
  await using home = await tempHome();
  const fake = fakeSupervisor();
  await invoke(HUB, ['service', 'install'], { fake, home: home.path });

  const result = await invoke(HUB, ['service', 'install'], { fake, home: home.path });

  expect(result.code).toBe(0);
  expect(fake.calls).toEqual(['install', 'install']);
  expect(result.stdout).toContain('is unchanged');
  expect(result.stdout).toContain('Restarted com.dbtlr.heimdall.hub');
});

test('the Collector unit runs run', async () => {
  await using home = await tempHome();
  const fake = fakeSupervisor();

  await invoke(COLLECTOR, ['service', 'install'], { fake, home: home.path });

  expect(fake.state.definition?.arguments).toEqual(['run']);
  expect(fake.state.definition?.log).toBe(
    join(home.path, '.local', 'state', 'heimdall', 'collector.log'),
  );
});

test('install --port writes the port into hub.toml before installing', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'install', '--port', '9090'], { home: home.path });

  expect(result.code).toBe(0);
  expect(await readFile(join(home.path, '.config', 'heimdall', 'hub.toml'), 'utf8')).toBe(
    'port = 9090\n',
  );
  expect(result.stdout).toContain('Set port = 9090 in ~/.config/heimdall/hub.toml.');
});

test('install --port leaves a hub.toml that already holds the port untouched', async () => {
  await using home = await tempHome();
  const file = join(home.path, '.config', 'heimdall', 'hub.toml');
  await mkdir(join(home.path, '.config', 'heimdall'), { recursive: true });
  const rendered = 'port=9090\n\n[database]\nurl = "postgres://db/heimdall"\n';
  await writeFile(file, rendered);
  const before = await stat(file);

  const result = await invoke(HUB, ['service', 'install', '--port', '9090'], { home: home.path });

  expect(result.code).toBe(0);
  expect(await readFile(file, 'utf8')).toBe(rendered);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(result.stdout).not.toContain('Set port');
});

test.each([['0'], ['65536'], ['http']])('install --port %s is a usage error', async (port) => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'install', '--port', port], { home: home.path });

  expect(result.code).toBe(2);
  expect(result.calls).toEqual([]);
});

test('the Collector install takes no port', async () => {
  await using home = await tempHome();

  const result = await invoke(COLLECTOR, ['service', 'install', '--port', '9090'], {
    home: home.path,
  });

  expect(result.code).toBe(2);
  expect(result.calls).toEqual([]);
});

test.each(['install', 'uninstall', 'start', 'stop', 'restart'])(
  '%s on a platform with no supervisor backend names the platforms that have one',
  async (verb) => {
    await using home = await tempHome();

    const result = await invoke(HUB, ['service', verb], {
      environment: { platform: 'win32' },
      home: home.path,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Service management on win32 is not supported. heimdall-hub service works on Linux and macOS.',
    );
    expect(result.calls).toEqual([]);
  },
);

test('install from a source run names the compile requirement before the platform', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'install'], {
    environment: { compiled: () => false, platform: 'win32' },
    home: home.path,
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('not a compiled binary');
});

test('uninstall removes the unit and says what stays', async () => {
  await using home = await tempHome();
  const fake = fakeSupervisor({ installed: true });

  const result = await invoke(HUB, ['service', 'uninstall'], { fake, home: home.path });

  expect(result.code).toBe(0);
  expect(fake.calls).toEqual(['uninstall']);
  expect(result.stdout).toBe(
    'Removed com.dbtlr.heimdall.hub: stopped it and deleted /home/operator/.config/systemd/user/fake.service. Its config file and log stay.\n',
  );
});

test('uninstall with nothing installed says so and succeeds', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'uninstall'], { home: home.path });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('com.dbtlr.heimdall.hub is not installed');
});

test.each(['start', 'stop', 'restart'])('%s drives the installed unit', async (verb) => {
  await using home = await tempHome();
  const fake = fakeSupervisor({ installed: true });

  const result = await invoke(HUB, ['service', verb], { fake, home: home.path });

  expect(result.code).toBe(0);
  expect(fake.calls).toEqual([verb]);
});

test.each(['start', 'stop', 'restart'])(
  '%s with no unit installed fails with a message that names install',
  async (verb) => {
    await using home = await tempHome();

    const result = await invoke(HUB, ['service', verb], { home: home.path });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'com.dbtlr.heimdall.hub is not installed. Run heimdall-hub service install first.',
    );
  },
);

test('status of a running Hub shows its health and every path', async () => {
  await using home = await tempHome();
  const seen: string[] = [];

  const result = await invoke(HUB, ['service', 'status'], {
    environment: healthy('0.2.0', seen),
    fake: fakeSupervisor({ installed: true, unit: join(home.path, 'unit.service') }),
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`com.dbtlr.heimdall.hub: loaded, running (pid 4182)
  health   ok, v0.2.0 (http://127.0.0.1:8080/api/health)
  unit     ~/unit.service
  log      ~/.local/state/heimdall/hub.log
  config   ~/.config/heimdall/hub.toml
`);
  expect(seen).toEqual(['http://127.0.0.1:8080/api/health']);
});

test('status asks for health on the port the Hub reads from its config file', async () => {
  await using home = await tempHome();
  await mkdir(join(home.path, '.config', 'heimdall'), { recursive: true });
  await writeFile(
    join(home.path, '.config', 'heimdall', 'hub.toml'),
    'port = 9191\n\n[database]\nurl = "postgres://db/heimdall"\n',
  );
  const seen: string[] = [];

  await invoke(HUB, ['service', 'status'], {
    environment: healthy('0.2.0', seen),
    fake: fakeSupervisor({ installed: true }),
    home: home.path,
  });

  expect(seen).toEqual(['http://127.0.0.1:9191/api/health']);
});

test('status of a Hub whose database is not answering says so, and exits 0', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'status'], {
    environment: {
      fetch: () =>
        Promise.resolve(
          Response.json({ database: 'not answering', version: '0.2.0' }, { status: 503 }),
        ),
    },
    fake: fakeSupervisor({ installed: true }),
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    '  health   database not answering, v0.2.0 (http://127.0.0.1:8080/api/health)\n',
  );
});

test('status of a running Hub that does not answer says so, and exits 0', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'status'], {
    fake: fakeSupervisor({ installed: true }),
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('  health   no answer (http://127.0.0.1:8080/api/health)\n');
});

test('status shows restart pending while an older Hub still runs', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'status'], {
    environment: healthy('0.1.0'),
    fake: fakeSupervisor({ installed: true }),
    home: home.path,
  });

  expect(result.stdout).toContain('restart pending, this binary is v0.2.0');
});

test('status of a stopped Hub asks nothing of it, and exits 0', async () => {
  await using home = await tempHome();
  const seen: string[] = [];

  const result = await invoke(HUB, ['service', 'status'], {
    environment: healthy('0.2.0', seen),
    fake: fakeSupervisor({ installed: true, running: false }),
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith('com.dbtlr.heimdall.hub: loaded, stopped\n  unit ');
  expect(seen).toEqual([]);
});

test('status with nothing installed says so, lists the paths, and exits 0', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'status'], {
    fake: fakeSupervisor({ unit: join(home.path, 'unit.service') }),
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`com.dbtlr.heimdall.hub: not installed
  unit     ~/unit.service
  log      ~/.local/state/heimdall/hub.log
  config   ~/.config/heimdall/hub.toml
`);
});

test('status passes on the supervisor notes, such as linger being off', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'status'], {
    fake: fakeSupervisor({ notes: ['linger is off; the unit stops at logout'] }),
    home: home.path,
  });

  expect(result.stdout).toEndWith('  note     linger is off; the unit stops at logout\n');
});

test('status exits 0 even when the supervisor fails or a setting is bad', async () => {
  await using home = await tempHome();
  const fake = fakeSupervisor({ installed: true });
  fake.supervisor.status = () => Promise.reject(new Error('the manager went away'));

  const result = await invoke(HUB, ['service', 'status'], {
    env: { HEIMDALL_PORT: 'not-a-port' },
    fake,
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith(
    'com.dbtlr.heimdall.hub: state unknown (the manager went away)\n',
  );
});

test('status with a port setting that is not a port says so, and exits 0', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'status'], {
    env: { HEIMDALL_PORT: 'not-a-port' },
    fake: fakeSupervisor({ installed: true }),
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    '  health   unknown (the port setting not-a-port is not a port)\n',
  );
});

test('status on a platform with no supervisor backend says so, and exits 0', async () => {
  await using home = await tempHome();

  const result = await invoke(HUB, ['service', 'status'], {
    environment: { platform: 'win32' },
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith(
    'com.dbtlr.heimdall.hub: service management on win32 is not supported\n  log ',
  );
  expect(result.calls).toEqual([]);
});

test('Collector status counts the samples waiting in its default queue', async () => {
  await using home = await tempHome();
  waiting.length = 0;

  const result = await invoke(COLLECTOR, ['service', 'status'], {
    fake: fakeSupervisor({ installed: true, unit: join(home.path, 'unit.service') }),
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`com.dbtlr.heimdall.collector: loaded, running (pid 4182)
  queue    12 samples waiting
  unit     ~/unit.service
  log      ~/.local/state/heimdall/collector.log
  config   ~/.config/heimdall/collector.toml
`);
  expect(waiting).toEqual([join(home.path, 'default-state')]);
});

test('Collector status reads the state directory the way run does', async () => {
  await using home = await tempHome();
  waiting.length = 0;
  await mkdir(join(home.path, '.config', 'heimdall'), { recursive: true });
  await writeFile(
    join(home.path, '.config', 'heimdall', 'collector.toml'),
    `hub = "http://hub.example/"\nstateDir = "${join(home.path, 'empty')}"\n`,
  );

  const result = await invoke(COLLECTOR, ['service', 'status'], { home: home.path });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('  queue    no queue yet; run has not started\n');
  expect(waiting).toEqual([join(home.path, 'empty')]);
});

test('Collector status reports a queue it cannot read, and exits 0', async () => {
  await using home = await tempHome();

  const result = await invoke(
    { ...COLLECTOR, queueDepth: () => Promise.reject(new Error('file is not a database')) },
    ['service', 'status'],
    { home: home.path },
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('  queue    unreadable (file is not a database)\n');
});

test('install --port refuses to create hub.toml beside a hub.json, and writes nothing', async () => {
  await using home = await tempHome();
  const dir = join(home.path, '.config', 'heimdall');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'hub.json'), '{"database":{"url":"postgres://db/heimdall"}}');

  const result = await invoke(HUB, ['service', 'install', '--port', '9090'], { home: home.path });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('hub.json holds the settings');
  expect(result.calls).toEqual([]);
  expect(await Bun.file(join(dir, 'hub.toml')).exists()).toBe(false);
  expect(await Bun.file(join(home.path, '.local')).exists()).toBe(false);
});

// A home whose hub.toml holds `lines`.
const hubConfig = async (home: string, lines: string[]) => {
  await mkdir(join(home, '.config', 'heimdall'), { recursive: true });
  await writeFile(join(home, '.config', 'heimdall', 'hub.toml'), lines.join('\n'));
};

test.each([
  ['host = "100.64.0.7"', 'http://100.64.0.7:9191/api/health'],
  ['host = "0.0.0.0"', 'http://127.0.0.1:9191/api/health'],
  ['host = "::"', 'http://127.0.0.1:9191/api/health'],
  ['host = "::1"', 'http://[::1]:9191/api/health'],
  ['', 'http://127.0.0.1:9191/api/health'],
])('status with %j asks %s for health', async (host, url) => {
  await using home = await tempHome();
  await hubConfig(home.path, [host, 'port = 9191']);
  const seen: string[] = [];

  await invoke(HUB, ['service', 'status'], {
    environment: healthy('0.2.0', seen),
    fake: fakeSupervisor({ installed: true }),
    home: home.path,
  });

  expect(seen).toEqual([url]);
});

test('status asks for health when the unit state is unknown', async () => {
  await using home = await tempHome();
  const fake = fakeSupervisor({ installed: true });
  fake.supervisor.status = () => Promise.reject(new Error('the manager went away'));

  const result = await invoke(HUB, ['service', 'status'], {
    environment: healthy('0.2.0'),
    fake,
    home: home.path,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('  health   ok, v0.2.0 (http://127.0.0.1:8080/api/health)\n');
});

const AGENT = 'com.dbtlr.heimdall.collector';
const PLIST_SHOWN = `~/Library/LaunchAgents/${AGENT}.plist`;

// The shared factory on macOS, choosing its backend as a real run does, with
// `launchd` answering in place of launchd for user 501.
const onMacOS = (launchd: ReturnType<typeof fakeLaunchd>): Partial<ServiceEnvironment> => ({
  executable: '/opt/heimdall/bin/heimdall-collector',
  platform: 'darwin',
  supervisor: (place) => platformSupervisor({ ...place, runner: launchd.runner, uid: 501 }),
});

// Runs `heimdall-collector service <verb>` on macOS against `launchd`.
const onMac = (verb: string, launchd: ReturnType<typeof fakeLaunchd>, home: string) =>
  invoke(COLLECTOR, ['service', verb], { environment: onMacOS(launchd), home });

test('install on macOS writes a LaunchAgents plist and loads it into the GUI domain', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd();
  const plist = join(home.path, 'Library', 'LaunchAgents', `${AGENT}.plist`);

  const result = await onMac('install', launchd, home.path);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`Wrote ${PLIST_SHOWN}.
Restarted ${AGENT}; it logs to ~/.local/state/heimdall/collector.log.
`);
  expect((await stat(join(home.path, '.local', 'state', 'heimdall'))).isDirectory()).toBe(true);
  expect(await readFile(plist, 'utf8')).toContain(
    '<string>/opt/heimdall/bin/heimdall-collector</string>\n    <string>run</string>',
  );
  expect(launchd.calls).toEqual([
    `launchctl print gui/501/${AGENT}`,
    `launchctl enable gui/501/${AGENT}`,
    `launchctl bootstrap gui/501 ${plist}`,
  ]);
});

test('Collector status on macOS names the agent state, plist, log, and queue, with no note', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd();
  await onMac('install', launchd, home.path);

  const result = await onMac('status', launchd, home.path);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${AGENT}: loaded, running (pid 4182)
  queue    12 samples waiting
  unit     ${PLIST_SHOWN}
  log      ~/.local/state/heimdall/collector.log
  config   ~/.config/heimdall/collector.toml
`);
});

test('stop on macOS boots the agent out, and status then reads it as stopped', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd();
  await onMac('install', launchd, home.path);
  launchd.calls.length = 0;

  const stopped = await onMac('stop', launchd, home.path);
  const result = await onMac('status', launchd, home.path);

  expect(stopped.code).toBe(0);
  expect(stopped.stdout).toBe(`Stopped ${AGENT}.\n`);
  expect(launchd.calls.slice(0, 2)).toEqual([
    `launchctl bootout gui/501/${AGENT}`,
    `launchctl print gui/501/${AGENT}`,
  ]);
  expect(result.stdout).toStartWith(`${AGENT}: not loaded, stopped\n`);
  expect(result.stdout).not.toContain('note');
});

test('status on macOS notes when there is no GUI login session, and exits 0', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd({ domain: false });
  await onMac('install', fakeLaunchd(), home.path);

  const result = await onMac('status', launchd, home.path);

  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith(`${AGENT}: not loaded, stopped\n`);
  expect(result.stdout).toEndWith(
    '  note     no GUI login session; the agent loads when the user logs in\n',
  );
});

test.each(['start', 'stop', 'restart'])(
  '%s on macOS with no agent installed fails with a message that names install',
  async (verb) => {
    await using home = await tempHome();
    const launchd = fakeLaunchd();

    const result = await onMac(verb, launchd, home.path);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${AGENT} is not installed. Run heimdall-collector service install first.`,
    );
    expect(launchd.calls).toEqual([]);
  },
);

test('uninstall on macOS boots the agent out and deletes its plist, in words true on macOS', async () => {
  await using home = await tempHome();
  const launchd = fakeLaunchd();
  await onMac('install', launchd, home.path);
  launchd.calls.length = 0;

  const result = await onMac('uninstall', launchd, home.path);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    `Removed ${AGENT}: stopped it and deleted ${PLIST_SHOWN}. Its config file, log, and queue stay.\n`,
  );
  expect(launchd.calls).toEqual([
    `launchctl bootout gui/501/${AGENT}`,
    `launchctl print gui/501/${AGENT}`,
  ]);
  expect(
    await Bun.file(join(home.path, 'Library', 'LaunchAgents', `${AGENT}.plist`)).exists(),
  ).toBe(false);
});

test('install on macOS whose bootout fails exits 1 and leaves the old plist in place', async () => {
  await using home = await tempHome();
  const plist = join(home.path, 'Library', 'LaunchAgents', `${AGENT}.plist`);
  await mkdir(dirname(plist), { recursive: true });
  await writeFile(plist, 'the plist an older install wrote');
  const launchd = fakeLaunchd({
    answers: {
      bootout: [{ code: 1, stderr: 'Boot-out failed: 1: Operation not permitted', stdout: '' }],
    },
    loaded: true,
  });

  const result = await onMac('install', launchd, home.path);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`Could not install ${AGENT}: launchctl bootout failed (exit 1)`);
  expect(await readFile(plist, 'utf8')).toBe('the plist an older install wrote');
});

test('status on macOS exits 0 with the state unknown when launchctl times out', async () => {
  await using home = await tempHome();
  await onMac('install', fakeLaunchd(), home.path);
  const launchd = fakeLaunchd({
    answers: { print: [{ code: 124, stderr: 'timed out after 5 s', stdout: '' }] },
  });

  const result = await onMac('status', launchd, home.path);

  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith(
    `${AGENT}: state unknown (launchctl print failed (exit 124))\n`,
  );
});

test('Linux chooses the systemd backend and its user unit file', () => {
  const supervisor = platformSupervisor({
    home: '/home/operator',
    label: 'com.dbtlr.heimdall.hub',
    platform: 'linux',
    runner: () => Promise.reject(new Error('not run')),
    uid: 1000,
  });

  expect(supervisor.unit).toBe(
    '/home/operator/.config/systemd/user/com.dbtlr.heimdall.hub.service',
  );
});
