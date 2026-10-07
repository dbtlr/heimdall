import { expect, test } from 'bun:test';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { givenIdentity, invoke, TOKEN } from './testing/cli.ts';
import { fakeHub, rawHub, unreachableHub } from './testing/fake-hub.ts';
import { tempStateDir } from './testing/fixtures.ts';

const CODE = '7k3m-q9xa';
const NEW_TOKEN = 'Zx9_Lm-2Qp8Rt5Wv1Yb3Nc6Hd0Kf4Gj7Ss2Ae9Ui0Oo';

const paired =
  (system = 'desktop-1', token = NEW_TOKEN) =>
  () =>
    Response.json({ system, token }, { headers: { 'cache-control': 'no-store' } });

const refused = () => Response.json({ error: 'invalid or expired code' }, { status: 400 });

// Runs `heimdall-collector pair <code>` against `hub` with `stateDir` as its state directory.
const pair = (hub: string, stateDir: string, code = CODE) =>
  invoke(['pair', code, '--hub', hub, '--state-dir', stateDir]);

// Asserts nothing printed holds the code or either token.
const expectNoSecrets = (output: { stderr: string; stdout: string }) => {
  for (const secret of [CODE, CODE.toUpperCase(), TOKEN, NEW_TOKEN]) {
    expect(output.stdout).not.toContain(secret);
    expect(output.stderr).not.toContain(secret);
  }
};

test('pair redeems the code as given and keeps the System name and token in identity.json, readable by its owner alone', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());

  const result = await pair(`${hub.url}/`, dir.path);

  expect(hub.requests).toEqual([
    { body: JSON.stringify({ code: CODE }), method: 'POST', path: '/api/v1/pair' },
  ]);
  const path = join(dir.path, 'identity.json');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    hub: hub.url,
    system: 'desktop-1',
    token: NEW_TOKEN,
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir.path)).toEqual(['identity.json']);
  expect(result.stdout).toBe(
    'Paired as desktop-1.\nIf the Collector runs as a Service, run heimdall-collector service restart.\n',
  );
  expectNoSecrets(result);
  expect(result.code).toBe(0);
});

test('pair creates the state directory it keeps the identity in', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());
  const stateDir = join(dir.path, 'not', 'yet');

  const { code } = await pair(hub.url, stateDir);

  expect(await Bun.file(join(stateDir, 'identity.json')).exists()).toBe(true);
  expect(code).toBe(0);
});

test('pair reaches the Hub under the path prefix its URL carries', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());

  await pair(`${hub.url}/heimdall`, dir.path);

  expect(hub.requests.map((request) => request.path)).toEqual(['/heimdall/api/v1/pair']);
  // The identity is bound to the Hub's origin, not to the path under it.
  const identity = JSON.parse(await readFile(join(dir.path, 'identity.json'), 'utf8')) as {
    hub: string;
  };
  expect(identity.hub).toBe(hub.url);
});

test('pair reads the Hub and state directory from the configuration file, as run does', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());
  const stateDir = join(dir.path, 'state');
  await mkdir(join(dir.path, '.config', 'heimdall'), { recursive: true });
  await writeFile(
    join(dir.path, '.config', 'heimdall', 'collector.toml'),
    [`hub = "${hub.url}/"`, `stateDir = "${stateDir}"`].join('\n'),
  );

  const { code } = await invoke(['pair', CODE], { cwd: dir.path, env: { HOME: dir.path } });

  expect(hub.requests).toHaveLength(1);
  expect(await Bun.file(join(stateDir, 'identity.json')).exists()).toBe(true);
  expect(code).toBe(0);
});

test('pair without a Hub is a usage error that names the option', async () => {
  await using dir = await tempStateDir();

  const { code, stderr } = await invoke(['pair', CODE, '--state-dir', dir.path]);

  expect(stderr).toContain('--hub');
  expect(code).toBe(2);
});

test('pair without a code is a usage error', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());

  const { code } = await invoke(['pair', '--hub', hub.url, '--state-dir', dir.path]);

  expect(hub.requests).toEqual([]);
  expect(code).toBe(2);
});

test('pairing again replaces the identity with a new file and says the token was rotated', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired('desktop-1'));
  const path = await givenIdentity(dir.path, { system: 'desktop-1' });
  const before = await stat(path);

  const result = await pair(hub.url, dir.path);

  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    hub: hub.url,
    system: 'desktop-1',
    token: NEW_TOKEN,
  });
  // A rename replaces the file whole, so a reader sees the old identity or the new one.
  expect((await stat(path)).ino).not.toBe(before.ino);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir.path)).toEqual(['identity.json']);
  expect(result.stdout).toBe(
    'Paired as desktop-1.\nThis replaced the token this System held; the old one no longer works.\nIf the Collector runs as a Service, run heimdall-collector service restart.\n',
  );
  expectNoSecrets(result);
  expect(result.code).toBe(0);
});

// Each failure leaves an identity that was there byte for byte as it was.
const failsKeepingIdentity = async (hub: string, message: string) => {
  await using dir = await tempStateDir();
  const path = await givenIdentity(dir.path);
  const before = await readFile(path);

  const result = await pair(hub, dir.path);

  expect(await readFile(path)).toEqual(before);
  expect(await readdir(dir.path)).toEqual(['identity.json']);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(message);
  expectNoSecrets(result);
  expect(result.code).toBe(1);
};

test('a refused code exits 1, says so, and leaves the identity as it was', async () => {
  await using hub = fakeHub(refused);

  await failsKeepingIdentity(hub.url, 'The Hub refused the code: it is invalid or expired.');
});

test('a Hub that paused pairing exits 1 and says when to try again', async () => {
  await using hub = fakeHub(() =>
    Response.json(
      { error: 'too many failed codes; try again later' },
      { headers: { 'retry-after': '42' }, status: 429 },
    ),
  );

  await failsKeepingIdentity(
    hub.url,
    'The Hub has paused pairing after too many failed codes. Try again after 42 seconds.',
  );
});

test('an unreachable Hub exits 1, names the Hub, and leaves the identity as it was', async () => {
  const hub = unreachableHub();

  await failsKeepingIdentity(hub, `Could not reach the Hub at ${hub}: `);
});

test('a Hub answering some other status exits 1 and names it', async () => {
  await using hub = fakeHub(() => new Response('Not found.', { status: 404 }));

  await failsKeepingIdentity(
    hub.url,
    `The Hub at ${hub.url}/ answered 404 to the Pairing request.`,
  );
});

test.each([
  ['not JSON', () => new Response(`{"system":"desktop-1","token":"${NEW_TOKEN}"`)],
  ['no token', () => Response.json({ system: 'desktop-1' })],
  ['an empty token', paired('desktop-1', '')],
  ['a token that is not base64url', paired('desktop-1', `${NEW_TOKEN}+/=`)],
  ['a System outside Fleet names', paired('Desktop_1')],
  ['no System', () => Response.json({ token: NEW_TOKEN })],
])('a successful answer with %s exits 1 and leaves the identity as it was', async (_, answer) => {
  await using hub = fakeHub(answer);

  await failsKeepingIdentity(hub.url, 'did not hold a System name and token');
});

test('an answer larger than 4 KiB exits 1, says it was too large, and leaves the identity as it was', async () => {
  await using hub = fakeHub(
    () =>
      new Response(
        new ReadableStream({
          pull: (controller) => controller.enqueue(new TextEncoder().encode(' '.repeat(1024))),
        }),
      ),
  );

  await failsKeepingIdentity(hub.url, "The Hub's answer was too large");
});

test('an answer that declares more than 4 KiB is too large before its body is read', async () => {
  await using hub = fakeHub(() =>
    Response.json({ padding: 'x'.repeat(5000), system: 'desktop-1', token: NEW_TOKEN }),
  );

  await failsKeepingIdentity(hub.url, "The Hub's answer was too large");
});

test('a connection that drops mid-answer exits 1 and says the code may be spent', async () => {
  await using hub = rawHub(
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"system":"desktop-1",',
  );

  await failsKeepingIdentity(
    hub.url,
    'The connection to the Hub dropped before its answer arrived in full',
  );
  await failsKeepingIdentity(
    hub.url,
    'The code may be spent: run heimdall-hub pair <system> again',
  );
});

test('a redirect is reported as an unexpected answer, and its target is never contacted', async () => {
  await using target = fakeHub(paired());
  await using hub = fakeHub(
    () => new Response(null, { headers: { location: `${target.url}/api/v1/pair` }, status: 302 }),
  );

  await failsKeepingIdentity(
    hub.url,
    `The Hub at ${hub.url}/ answered 302 to the Pairing request.`,
  );
  expect(target.requests).toEqual([]);
});

test('a state directory that cannot be created exits 1 before the code is sent, so it stays unspent', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());
  await writeFile(join(dir.path, 'a-file'), '');

  const result = await pair(hub.url, join(dir.path, 'a-file', 'state'));

  expect(hub.requests).toEqual([]);
  expect(result.stderr).toContain('Could not create the state directory');
  expect(result.code).toBe(1);
});

test('pair creates the state directory readable by its owner alone', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());
  const stateDir = join(dir.path, 'new');

  await pair(hub.url, stateDir);

  expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
});

test('pair leaves the mode of a state directory that exists as it was', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());
  await chmod(dir.path, 0o755);

  await pair(hub.url, dir.path);

  expect((await stat(dir.path)).mode & 0o777).toBe(0o755);
});

test('rotating over an identity others could read leaves one readable by its owner alone', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());
  const path = await givenIdentity(dir.path, { mode: 0o644, system: 'desktop-1' });

  const { code } = await pair(hub.url, dir.path);

  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(code).toBe(0);
});

test('an identity that cannot be written after the Hub paired exits 1, says the code is spent, and leaves no temporary file', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired());
  // A directory where the file goes: the rename over it fails.
  await mkdir(join(dir.path, 'identity.json', 'occupied'), { recursive: true });

  const result = await pair(hub.url, dir.path);

  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(
    'The Hub paired this System as desktop-1, but its identity could not be kept',
  );
  expect(result.stderr).toContain('The code is spent');
  expect(result.stderr).not.toContain('rotated');
  expectNoSecrets(result);
  expect(await readdir(dir.path)).toEqual(['identity.json']);
  expect(result.code).toBe(1);
});

test('an identity that cannot be replaced after rotating says the old token no longer works', async () => {
  await using dir = await tempStateDir();
  await using hub = fakeHub(paired('desktop-1'));
  const path = await givenIdentity(dir.path, { system: 'desktop-1' });
  const before = await readFile(path);
  // A state directory the Collector cannot write to: no temporary file can be made.
  await chmod(dir.path, 0o500);
  let result: Awaited<ReturnType<typeof pair>>;
  try {
    result = await pair(hub.url, dir.path);
  } finally {
    await chmod(dir.path, 0o700);
  }

  expect(result.stderr).toContain('The code is spent');
  expect(result.stderr).toContain(
    "The Hub has already rotated desktop-1's token, so the token this System holds no longer works",
  );
  expect(result.stderr).toContain('until this System pairs again');
  expectNoSecrets(result);
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(dir.path)).toEqual(['identity.json']);
  expect(result.code).toBe(1);
});
