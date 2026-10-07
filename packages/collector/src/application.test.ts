import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { givenIdentity, invoke, TOKEN } from './testing/cli.ts';
import { fakeHub } from './testing/fake-hub.ts';
import { tempStateDir } from './testing/fixtures.ts';
import { versionLine } from './version.ts';

test('--version prints the version line Fleet compares and exits 0', async () => {
  const { code, stderr, stdout } = await invoke(['--version']);
  expect(stdout).toBe(`${versionLine()}\n`);
  expect(stderr).toBe('');
  expect(code).toBe(0);
});

test('a bare invocation is a usage error', async () => {
  const { code, stderr, stdout } = await invoke([]);
  expect(stdout).toBe('');
  expect(stderr).toContain('run');
  expect(stderr).toContain('heimdall-collector --help');
  expect(code).toBe(2);
});

test('an unknown option is a usage error', async () => {
  const { code, stderr, stdout } = await invoke(['--bogus']);
  expect(stdout).toBe('');
  expect(stderr).toContain('--bogus');
  expect(code).toBe(2);
});

test('a stray argument is a usage error', async () => {
  const { code, stderr, stdout } = await invoke(['run', 'now']);
  expect(stdout).toBe('');
  expect(stderr).toContain('accepts no arguments');
  expect(code).toBe(2);
});

// A run cancelled as soon as it starts: enough to see which settings it resolved.
const startAndStop = (argv: string[], env: Record<string, string> = {}) => invoke(argv, { env });

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u;

test('run reads its settings from the configuration file and its identity from the state directory', async () => {
  await using dir = await tempStateDir();
  const stateDir = join(dir.path, 'state');
  await givenIdentity(stateDir, { hub: 'http://heimdall.example:8080', system: 'server-1' });
  const configFile = join(dir.path, 'collector.toml');
  await writeFile(
    configFile,
    ['hub = "http://heimdall.example:8080/"', `stateDir = "${stateDir}"`].join('\n'),
  );

  const { code, stderr, stdout } = await startAndStop(['run', '--config', configFile]);

  expect(stdout).toContain('Sampling server-1 every 15 seconds for http://heimdall.example:8080/');
  expect(stdout).not.toContain(TOKEN);
  expect(stderr).not.toContain(TOKEN);
  expect(await Bun.file(join(stateDir, 'queue.sqlite')).exists()).toBe(true);
  expect(code).toBe(130);
});

test('run finds the configuration file under ~/.config/heimdall/ when --config is absent', async () => {
  await using home = await tempStateDir();
  await using elsewhere = await tempStateDir();
  await givenIdentity(join(home.path, 'state'), { hub: 'http://heimdall.example:8080' });
  await mkdir(join(home.path, '.config', 'heimdall'), { recursive: true });
  await writeFile(
    join(home.path, '.config', 'heimdall', 'collector.toml'),
    ['hub = "http://heimdall.example:8080/"', `stateDir = "${join(home.path, 'state')}"`].join(
      '\n',
    ),
  );

  const { code, stdout } = await invoke(['run'], {
    cwd: elsewhere.path,
    env: { HOME: home.path },
  });

  expect(stdout).toContain('Sampling server-1 every 15 seconds for http://heimdall.example:8080/');
  expect(code).toBe(130);
});

test('run settings from the environment override the configuration file', async () => {
  await using dir = await tempStateDir();
  await givenIdentity(join(dir.path, 'b'), { hub: 'http://b.example' });
  const configFile = join(dir.path, 'collector.json');
  await writeFile(
    configFile,
    JSON.stringify({ hub: 'http://a.example/', stateDir: join(dir.path, 'a') }),
  );

  const { stdout } = await startAndStop(['run', '--config', configFile], {
    HEIMDALL_HUB: 'http://b.example/',
    HEIMDALL_STATE_DIR: join(dir.path, 'b'),
  });

  expect(stdout).toContain(`for http://b.example/; queue in ${join(dir.path, 'b')}.`);
});

test('run without a Hub is a usage error that names the option', async () => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path);
  const { code, stderr } = await startAndStop(['run', '--state-dir', dir.path]);

  expect(stderr).toContain('--hub');
  expect(code).toBe(2);
});

test('run with a Hub that is not an http URL is a usage error', async () => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path);
  const { code } = await startAndStop([
    'run',
    '--hub',
    'ftp://h.example/',
    '--state-dir',
    dir.path,
  ]);

  expect(code).toBe(2);
});

test.each([
  ['--system', 'server-1'],
  ['--token', 's3cret'],
])('run no longer takes %s', async (flag, value) => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path);
  const { code, stderr } = await startAndStop([
    'run',
    '--hub',
    'http://h.example/',
    '--state-dir',
    dir.path,
    flag,
    value,
  ]);

  expect(stderr).toContain(flag);
  expect(stderr).not.toContain('s3cret');
  expect(code).toBe(2);
});

test('run ignores the System and token a file or the environment still names, and uses its identity', async () => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path, { system: 'server-1' });
  const configFile = join(dir.path, 'collector.toml');
  await writeFile(
    configFile,
    [
      'hub = "http://h.example/"',
      'system = "server-9"',
      'token = "s3cret"',
      `stateDir = "${dir.path}"`,
    ].join('\n'),
  );

  const { code, stdout } = await startAndStop(['run', '--config', configFile], {
    HEIMDALL_SYSTEM: 'server-8',
    HEIMDALL_TOKEN: 's3cret',
  });

  expect(stdout).toContain('Sampling server-1 every');
  expect(code).toBe(130);
});

test('run refuses with a timestamped line when this System is not paired', async () => {
  await using dir = await tempStateDir();

  const { code, stderr, stdout } = await startAndStop([
    'run',
    '--hub',
    'http://h.example/',
    '--state-dir',
    dir.path,
  ]);

  expect(stdout).not.toContain('Sampling');
  const line = stderr.trim();
  expect(line).toMatch(ISO_TIME);
  expect(line).toEndWith('This System is not paired; run heimdall-collector pair <code>.');
  expect(await Bun.file(join(dir.path, 'queue.sqlite')).exists()).toBe(false);
  expect(code).toBe(1);
});

test.each([
  ['not JSON', `{"hub": "http://h.example", "system": "server-1", "token": "${TOKEN}"`],
  ['no token', JSON.stringify({ hub: 'http://h.example', system: 'server-1' })],
  ['no Hub', JSON.stringify({ system: 'server-1', token: TOKEN })],
  [
    'a Hub that is not an origin',
    JSON.stringify({ hub: 'http://h.example/api', system: 'server-1', token: TOKEN }),
  ],
  ['an empty token', JSON.stringify({ hub: 'http://h.example', system: 'server-1', token: '' })],
  [
    'a System outside Fleet names',
    JSON.stringify({ hub: 'http://h.example', system: 'Server_1', token: TOKEN }),
  ],
])(
  'run refuses an identity file with %s, naming the file but not its token',
  async (_, content) => {
    await using dir = await tempStateDir();
    await writeFile(join(dir.path, 'identity.json'), content, { mode: 0o600 });

    const { code, stderr, stdout } = await startAndStop([
      'run',
      '--hub',
      'http://h.example/',
      '--state-dir',
      dir.path,
    ]);

    expect(stdout).not.toContain('Sampling');
    expect(stderr).toMatch(ISO_TIME);
    expect(stderr).toContain('not paired');
    expect(stderr).toContain(join(dir.path, 'identity.json'));
    expect(stderr).toContain('run heimdall-collector pair <code>.');
    expect(stderr).not.toContain(TOKEN.slice(0, 8));
    expect(code).toBe(1);
  },
);

test('run warns, once and timestamped, when its identity is not private, and still runs', async () => {
  await using dir = await tempStateDir();
  const identity = await givenIdentity(dir.path, { mode: 0o644 });
  await chmod(dir.path, 0o777);

  const { code, stdout } = await startAndStop([
    'run',
    '--hub',
    'http://h.example/',
    '--state-dir',
    dir.path,
  ]);

  const warnings = stdout.split('\n').filter((line) => line.includes('warning:'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(ISO_TIME);
  expect(warnings[0]).toContain('The identity is not private:');
  expect(warnings[0]).toContain(`${identity} has mode 0644`);
  expect(warnings[0]).toContain(`chmod 600 ${identity}`);
  expect(warnings[0]).toContain(`chmod go-w ${dir.path}`);
  expect(stdout).toContain('Sampling server-1');
  expect(code).toBe(130);
});

test.each([
  ['scheme', 'https://127.0.0.1:PORT'],
  ['host', 'http://localhost:PORT'],
  ['port', 'http://127.0.0.1:OTHER'],
])(
  'run refuses, sending nothing, when its identity is bound to a Hub of another %s',
  async (_, bound) => {
    await using dir = await tempStateDir();
    await using hub = fakeHub(() => new Response(null, { status: 200 }));
    const { port } = new URL(hub.url);
    const origin = bound.replace('OTHER', String(Number(port) + 1)).replace('PORT', port);
    await givenIdentity(dir.path, { hub: origin });

    const { code, stderr, stdout } = await startAndStop([
      'run',
      '--hub',
      `${hub.url}/`,
      '--state-dir',
      dir.path,
    ]);

    expect(stdout).not.toContain('Sampling');
    const line = stderr.trim();
    expect(line).toMatch(ISO_TIME);
    expect(line).toEndWith(
      `This System was paired with ${origin}, but collector.toml names ${hub.url}; pair again with the new Hub (heimdall-collector pair <code>).`,
    );
    expect(hub.requests).toEqual([]);
    expect(await Bun.file(join(dir.path, 'queue.sqlite')).exists()).toBe(false);
    expect(code).toBe(1);
  },
);

test('run accepts a Hub URL whose path differs from the one it paired with, at the same origin', async () => {
  await using dir = await tempStateDir();
  await givenIdentity(dir.path, { hub: 'http://h.example:8080' });

  const { code, stdout } = await startAndStop([
    'run',
    '--hub',
    'http://H.example:8080/heimdall/api',
    '--state-dir',
    dir.path,
  ]);

  expect(stdout).toContain('Sampling server-1');
  expect(code).toBe(130);
});

// A home whose Collector config keeps the queue under it, for runs that start.
const homeWithConfig = async ({ paired = true } = {}) => {
  const home = await tempStateDir();
  await mkdir(join(home.path, '.config', 'heimdall'), { recursive: true });
  await writeFile(
    join(home.path, '.config', 'heimdall', 'collector.toml'),
    ['hub = "http://heimdall.example:8080/"', `stateDir = "${join(home.path, 'state')}"`].join(
      '\n',
    ),
  );
  if (paired) {
    await givenIdentity(join(home.path, 'state'), { hub: 'http://heimdall.example:8080' });
  }
  return home;
};

test('run starts every runtime line with its ISO 8601 UTC time', async () => {
  await using home = await homeWithConfig();

  const { stdout } = await invoke(['run'], { cwd: home.path, env: { HOME: home.path } });

  const lines = stdout.trimEnd().split('\n');
  expect(lines[0]).toContain('Sampling server-1');
  for (const line of lines) {
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S/u);
  }
});

test('run rotates a log from before timestamps as it starts', async () => {
  await using home = await homeWithConfig();
  const logDir = join(home.path, '.local', 'state', 'heimdall');
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, 'collector.log'), 'Sampling server-1 every 15 seconds.\n');

  const { code } = await invoke(['run'], { cwd: home.path, env: { HOME: home.path } });

  expect(await readFile(join(logDir, 'collector.log.1'), 'utf8')).toBe(
    'Sampling server-1 every 15 seconds.\n',
  );
  expect(await readFile(join(logDir, 'collector.log'), 'utf8')).toBe('');
  expect(code).toBe(130);
});

test('service uninstall refuses to run from source', async () => {
  const { code, stderr } = await invoke(['service', 'uninstall']);

  expect(stderr).toContain('not a compiled binary');
  expect(code).toBe(1);
});

test('service status names the paired System and counts the queue the way run finds them, and exits 0', async () => {
  await using home = await homeWithConfig();

  const { code, stdout } = await invoke(['service', 'status'], {
    cwd: home.path,
    env: { HOME: home.path },
  });

  expect(stdout).toStartWith('com.dbtlr.heimdall.collector: ');
  expect(stdout).toContain('  system   server-1 (paired with http://heimdall.example:8080)\n');
  expect(stdout).toContain('  queue    no queue yet; run has not started\n');
  expect(stdout).not.toContain(TOKEN);
  expect(code).toBe(0);
});

test('service status says when this System is not paired, and exits 0', async () => {
  await using home = await homeWithConfig({ paired: false });

  const { code, stdout } = await invoke(['service', 'status'], {
    cwd: home.path,
    env: { HOME: home.path },
  });

  expect(stdout).toContain('  system   not paired; run heimdall-collector pair <code>\n');
  expect(code).toBe(0);
});

test('service status flags a configured Hub other than the one this System paired with, and exits 0', async () => {
  await using home = await homeWithConfig({ paired: false });
  await givenIdentity(join(home.path, 'state'), { hub: 'http://old.example' });

  const { code, stdout } = await invoke(['service', 'status'], {
    cwd: home.path,
    env: { HOME: home.path },
  });

  expect(stdout).toContain(
    '  system   server-1, paired with http://old.example but configured for http://heimdall.example:8080; pair again\n',
  );
  expect(stdout).not.toContain(TOKEN);
  expect(code).toBe(0);
});
