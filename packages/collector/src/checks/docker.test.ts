import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { checkContainer, dockerEndpoint } from './docker.ts';

type Answer = { body?: unknown; delayMs?: number; raw?: string; status?: number };

// A fake Docker Engine on a unix socket in a temporary directory. `answers`
// maps a request path to what the Engine says; any other path is a 404 like
// the Engine's own.
const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
});

const fakeEngine = async (answers: Record<string, Answer>) => {
  const dir = await tempStateDir();
  const unix = join(dir.path, 'docker.sock');
  const requested: string[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      requested.push(request.method + ' ' + pathname);
      const answer = answers[pathname];
      if (answer === undefined) {
        return Response.json({ message: 'No such container' }, { status: 404 });
      }
      if (answer.delayMs !== undefined) {
        await Bun.sleep(answer.delayMs);
      }
      return new Response(answer.raw ?? JSON.stringify(answer.body), {
        headers: { 'content-type': 'application/json' },
        status: answer.status ?? 200,
      });
    },
    unix,
  });
  stoppers.push(async () => {
    await server.stop(true);
    await dir[Symbol.asyncDispose]();
  });
  return { requested, socket: unix };
};

const engineAt = (path: string) => ({ endpoint: { kind: 'unix', path } as const });

// What the Engine answers for `docker inspect` of a container in the given state.
const inspected = (state: Record<string, unknown>) => ({
  Id: 'abc123',
  Name: '/web',
  State: { Error: '', ExitCode: 0, ...state },
});

describe('a container the Engine reports', () => {
  test('running is up', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        body: inspected({ Paused: false, Restarting: false, Running: true, Status: 'running' }),
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'status running',
      state: 'up',
    });
  });

  test('exited is stopped, with its exit code', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        body: inspected({ ExitCode: 137, Running: false, Status: 'exited' }),
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'status exited, exit code 137',
      state: 'stopped',
    });
  });

  test('created is stopped, without an exit code it never had', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: inspected({ Running: false, Status: 'created' }) },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'status created',
      state: 'stopped',
    });
  });

  // The Engine reports Running: true for these two, so the status decides.
  test.each(['paused', 'restarting'])('%s is stopped though the Engine calls it running', async (status) => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: inspected({ ExitCode: 1, Running: true, Status: status }) },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: `status ${status}`,
      state: 'stopped',
    });
  });

  test('dead is stopped', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: inspected({ ExitCode: 2, Running: false, Status: 'dead' }) },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'status dead, exit code 2',
      state: 'stopped',
    });
  });

  test('is judged by running state alone, not by its own healthcheck', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        body: inspected({ Health: { Status: 'unhealthy' }, Running: true, Status: 'running' }),
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toMatchObject({ state: 'up' });
  });

  test('missing (404) is stopped', async () => {
    const { socket } = await fakeEngine({});

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'no such container',
      state: 'stopped',
    });
  });

  test('is asked for with a GET of its encoded name, so a name cannot change the path', async () => {
    const { requested, socket } = await fakeEngine({
      '/containers/a%20b%2Fc/json': { body: inspected({ Running: true, Status: 'running' }) },
    });

    expect(await checkContainer('a b/c', engineAt(socket))).toMatchObject({ state: 'up' });
    expect(requested).toEqual(['GET /containers/a%20b%2Fc/json']);
  });

  // A URL parser reads `.` and `..` as path segments, even as %2E, so they
  // would ask for another endpoint.
  test.each(['.', '..'])('named %s is never asked for', async (name) => {
    const { requested, socket } = await fakeEngine({});

    expect(await checkContainer(name, engineAt(socket))).toEqual({
      detail: 'not a container name',
      state: 'unknown',
    });
    expect(requested).toEqual([]);
  });
});

describe('a container the Engine cannot say anything sure about is unknown', () => {
  test('when the Engine fails (500)', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: { message: 'boom' }, status: 500 },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'Docker answered 500',
      state: 'unknown',
    });
  });

  test('when the answer is not JSON', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { raw: '<html>proxy</html>' },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'unexpected Docker answer',
      state: 'unknown',
    });
  });

  test.each([
    ['no State', {}],
    ['State without Running', { State: { Status: 'running' } }],
    ['a Running that is not a boolean', { State: { Running: 'yes', Status: 'running' } }],
    ['an array', []],
  ])('when the answer has %s', async (_name, body) => {
    const { socket } = await fakeEngine({ '/containers/web/json': { body } });

    expect(await checkContainer('web', engineAt(socket))).toMatchObject({
      detail: 'unexpected Docker answer',
      state: 'unknown',
    });
  });

  test('when the Engine does not answer in time', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: inspected({ Running: true, Status: 'running' }), delayMs: 500 },
    });

    expect(await checkContainer('web', { ...engineAt(socket), timeoutMs: 50 })).toEqual({
      detail: 'Docker timed out',
      state: 'unknown',
    });
  });

  test('when there is no socket', async () => {
    await using dir = await tempStateDir();

    expect(await checkContainer('web', engineAt(join(dir.path, 'missing.sock')))).toEqual({
      detail: 'Docker socket unreachable',
      state: 'unknown',
    });
  });

  test('when the endpoint is not a unix socket', async () => {
    expect(
      await checkContainer('web', { endpoint: { host: 'tcp://10.0.0.1:2375', kind: 'unsupported' } }),
    ).toEqual({ detail: 'DOCKER_HOST is not a unix socket', state: 'unknown' });
  });
});

describe('finding the Engine socket', () => {
  test('is DOCKER_HOST when it is a unix URL', () => {
    expect(dockerEndpoint({ env: { DOCKER_HOST: 'unix:///run/user/1001/docker.sock' }, uid: 5 })).toEqual({
      kind: 'unix',
      path: '/run/user/1001/docker.sock',
    });
  });

  test('is DOCKER_HOST even when XDG_RUNTIME_DIR is set', () => {
    expect(
      dockerEndpoint({ env: { DOCKER_HOST: 'unix:///x.sock', XDG_RUNTIME_DIR: '/run/user/7' }, uid: 5 }),
    ).toEqual({ kind: 'unix', path: '/x.sock' });
  });

  test.each(['tcp://127.0.0.1:2375', 'ssh://host', 'npipe:////./pipe/docker_engine', 'unix://relative.sock'])(
    'is unsupported when DOCKER_HOST is %s',
    (host) => {
      expect(dockerEndpoint({ env: { DOCKER_HOST: host }, uid: 5 })).toEqual({
        host,
        kind: 'unsupported',
      });
    },
  );

  test('is docker.sock under XDG_RUNTIME_DIR when DOCKER_HOST is unset or empty', () => {
    expect(dockerEndpoint({ env: { XDG_RUNTIME_DIR: '/run/user/7' }, uid: 5 })).toEqual({
      kind: 'unix',
      path: '/run/user/7/docker.sock',
    });
    expect(dockerEndpoint({ env: { DOCKER_HOST: '', XDG_RUNTIME_DIR: '/run/user/7' }, uid: 5 })).toEqual({
      kind: 'unix',
      path: '/run/user/7/docker.sock',
    });
  });

  test('is under /run/user/<uid> when nothing else names it', () => {
    expect(dockerEndpoint({ env: {}, uid: 1001 })).toEqual({
      kind: 'unix',
      path: '/run/user/1001/docker.sock',
    });
  });

  test('ignores a relative XDG_RUNTIME_DIR', () => {
    expect(dockerEndpoint({ env: { XDG_RUNTIME_DIR: 'run' }, uid: 1001 })).toEqual({
      kind: 'unix',
      path: '/run/user/1001/docker.sock',
    });
  });
});
