import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import type { ServiceCheckState } from '@heimdall/schema';
import { httpGet } from '@heimdall/service';
import type { HttpGet, HttpGetResult } from '@heimdall/service';
import { runWithProxy } from '@heimdall/service/testing';

import { tempStateDir } from '../testing/fixtures.ts';
import { checkContainer, dockerEndpoint } from './docker.ts';

type Answer = {
  body?: unknown;
  delayMs?: number;
  raw?: string;
  respond?: () => Response;
  status?: number;
};

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
      requested.push(`${request.method} ${pathname}`);
      const answer = answers[pathname];
      if (answer === undefined) {
        return Response.json({ message: 'No such container' }, { status: 404 });
      }
      if (answer.delayMs !== undefined) {
        await Bun.sleep(answer.delayMs);
      }
      if (answer.respond !== undefined) {
        return answer.respond();
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

const engineAt = (path: string) => ({ endpoint: { kind: 'unix', path } as const, get: httpGet });

// What the Engine answers for `docker inspect` of a container in the given state.
const inspected = (state: Record<string, unknown>, name = 'web') => ({
  Id: 'abc123',
  Name: `/${name}`,
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
  test.each(['paused', 'restarting'])(
    '%s is stopped though the Engine calls it running',
    async (status) => {
      const { socket } = await fakeEngine({
        '/containers/web/json': { body: inspected({ ExitCode: 1, Running: true, Status: status }) },
      });

      expect(await checkContainer('web', engineAt(socket))).toEqual({
        detail: `status ${status}`,
        state: 'stopped',
      });
    },
  );

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
      '/containers/a%20b%2Fc/json': {
        body: inspected({ Running: true, Status: 'running' }, 'a b/c'),
      },
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
      '/containers/web/json': {
        body: inspected({ Running: true, Status: 'running' }),
        delayMs: 500,
      },
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
      await checkContainer('web', {
        endpoint: { host: 'tcp://10.0.0.1:2375', kind: 'unsupported' },
        get: httpGet,
      }),
    ).toEqual({ detail: 'DOCKER_HOST is not a unix socket', state: 'unknown' });
  });
});

describe('finding the Engine socket', () => {
  test('is DOCKER_HOST when it is a unix URL', () => {
    expect(
      dockerEndpoint({ env: { DOCKER_HOST: 'unix:///run/user/1001/docker.sock' }, uid: 5 }),
    ).toEqual({
      kind: 'unix',
      path: '/run/user/1001/docker.sock',
    });
  });

  test('is DOCKER_HOST even when XDG_RUNTIME_DIR is set', () => {
    expect(
      dockerEndpoint({
        env: { DOCKER_HOST: 'unix:///x.sock', XDG_RUNTIME_DIR: '/run/user/7' },
        uid: 5,
      }),
    ).toEqual({ kind: 'unix', path: '/x.sock' });
  });

  test.each([
    'tcp://127.0.0.1:2375',
    'ssh://host',
    'npipe:////./pipe/docker_engine',
    'unix://relative.sock',
    'unix:///a.sock\nfoo',
    'xunix:///a',
    'unix://',
  ])('is unsupported when DOCKER_HOST is %s', (host) => {
    expect(dockerEndpoint({ env: { DOCKER_HOST: host }, uid: 5 })).toEqual({
      host,
      kind: 'unsupported',
    });
  });

  test('is docker.sock under XDG_RUNTIME_DIR when DOCKER_HOST is unset or empty', () => {
    expect(dockerEndpoint({ env: { XDG_RUNTIME_DIR: '/run/user/7' }, uid: 5 })).toEqual({
      kind: 'unix',
      path: '/run/user/7/docker.sock',
    });
    expect(
      dockerEndpoint({ env: { DOCKER_HOST: '', XDG_RUNTIME_DIR: '/run/user/7' }, uid: 5 }),
    ).toEqual({
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

// A 2xx or other status the Engine does not use for an inspect is not trusted.
describe('an answer that is not exactly a 200', () => {
  test.each([201, 206, 204])('a %i is unknown, even with a running body', async (status) => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        body: inspected({ Running: true, Status: 'running' }),
        status,
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: `Docker answered ${String(status)}`,
      state: 'unknown',
    });
  });

  test('a redirect is unknown and is not followed', async () => {
    let hits = 0;
    const elsewhere = Bun.serve({
      fetch: () => {
        hits += 1;
        return Response.json(inspected({ Running: true, Status: 'running' }));
      },
      port: 0,
    });
    try {
      const { socket } = await fakeEngine({
        '/containers/web/json': {
          respond: () =>
            new Response(null, {
              headers: { location: `http://127.0.0.1:${String(elsewhere.port)}/` },
              status: 302,
            }),
        },
      });

      expect(await checkContainer('web', engineAt(socket))).toEqual({
        detail: 'Docker answered 302',
        state: 'unknown',
      });
      expect(hits).toBe(0);
    } finally {
      await elsewhere.stop(true);
    }
  });
});

describe('a 404', () => {
  test.each([
    ['Docker', { message: 'No such container: web' }],
    [
      'Podman',
      {
        cause: 'no such container',
        message: 'no container with name or ID "web" found: no such container',
        response: 404,
      },
    ],
  ])('from %s saying no such container is stopped', async (_engine, body) => {
    const { socket } = await fakeEngine({ '/containers/web/json': { body, status: 404 } });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'no such container',
      state: 'stopped',
    });
  });

  test.each([
    ['a page not found', 'page not found'],
    ['a JSON message about something else', JSON.stringify({ message: 'page not found' })],
    ['JSON without a message', JSON.stringify({ error: 'no such container' })],
    ['a message that is not text', JSON.stringify({ message: ['no such container'] })],
    ['an empty body', ''],
  ])(
    'with %s is unknown, since something other than the Engine may have answered',
    async (_what, raw) => {
      const { socket } = await fakeEngine({ '/containers/web/json': { raw, status: 404 } });

      expect(await checkContainer('web', engineAt(socket))).toEqual({
        detail: 'Docker answered 404',
        state: 'unknown',
      });
    },
  );
});

// Moby looks a name up as an exact name first and then as an ID prefix, so an
// all-hex name like `cafe` can be answered with another container.
describe('an answer about another container than the one asked for', () => {
  const HEX = 'cafebabe1234';

  test('is stopped as no such container when the name differs', async () => {
    const { socket } = await fakeEngine({
      '/containers/cafe/json': {
        body: { ...inspected({ Running: true, Status: 'running' }, 'other'), Id: 'cafe00112233' },
      },
    });

    expect(await checkContainer('cafe', engineAt(socket))).toEqual({
      detail: 'no such container',
      state: 'stopped',
    });
  });

  test('is accepted when the recorded 12 to 64 hex digits start the ID', async () => {
    const { socket } = await fakeEngine({
      [`/containers/${HEX}/json`]: {
        body: {
          ...inspected({ Running: true, Status: 'running' }, 'web'),
          Id: `${HEX}${'0'.repeat(52)}`,
        },
      },
    });

    expect(await checkContainer(HEX, engineAt(socket))).toMatchObject({ state: 'up' });
  });

  test('is stopped when the recorded hex digits do not start the ID', async () => {
    const { socket } = await fakeEngine({
      [`/containers/${HEX}/json`]: {
        body: {
          ...inspected({ Running: true, Status: 'running' }, 'web'),
          Id: 'deadbeef1234abcd',
        },
      },
    });

    expect(await checkContainer(HEX, engineAt(socket))).toMatchObject({
      detail: 'no such container',
      state: 'stopped',
    });
  });

  test.each([
    ['fewer than 12 digits', 'cafe'],
    ['upper case digits', 'CAFEBABE1234'],
    ['a name with other characters', 'cafebabe123g'],
  ])('is not matched by ID prefix with %s', async (_what, recorded) => {
    const { socket } = await fakeEngine({
      [`/containers/${recorded}/json`]: {
        body: {
          ...inspected({ Running: true, Status: 'running' }, 'web'),
          Id: `${recorded.toLowerCase()}00`,
        },
      },
    });

    expect(await checkContainer(recorded, engineAt(socket))).toMatchObject({
      detail: 'no such container',
      state: 'stopped',
    });
  });

  test('is stopped when its Name has no leading slash, which the Engine always puts there', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        body: { Id: 'abc123', Name: 'web', State: { Running: true, Status: 'running' } },
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'no such container',
      state: 'stopped',
    });
  });

  test('is unknown when it names neither a Name nor an Id', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: { State: { Running: true, Status: 'running' } } },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'unexpected Docker answer',
      state: 'unknown',
    });
  });
});

describe('the size of an answer', () => {
  const MIB = 1024 * 1024;

  test('a Content-Length over 1 MiB is unknown', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        respond: () => Response.json({ ...inspected({ Running: true }), Pad: 'x'.repeat(2 * MIB) }),
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'Docker answer too large',
      state: 'unknown',
    });
  });

  test('an answer just under 1 MiB is read', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        body: { ...inspected({ Running: true, Status: 'running' }), Pad: 'x'.repeat(MIB - 1024) },
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toMatchObject({ state: 'up' });
  });

  test('an endless body with no Content-Length is cut off promptly, having been read only up to a cap', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let pulled = 0;
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        respond: () =>
          new Response(
            new ReadableStream({
              pull: (controller) => {
                pulled += chunk.length;
                controller.enqueue(chunk);
              },
            }),
          ),
      },
    });
    const started = performance.now();

    const outcome = await checkContainer('web', engineAt(socket));

    expect(outcome).toEqual({ detail: 'Docker answer too large', state: 'unknown' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(pulled).toBeLessThan(16 * MIB);
  });

  test('a body that stalls after its headers is a timeout', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        respond: () =>
          new Response(
            new ReadableStream({
              start: (controller) => {
                controller.enqueue(new TextEncoder().encode('{"State":'));
              },
            }),
          ),
      },
    });

    expect(await checkContainer('web', { ...engineAt(socket), timeoutMs: 100 })).toEqual({
      detail: 'Docker timed out',
      state: 'unknown',
    });
  });
});

describe('what the state says', () => {
  test('a container the Engine calls not running is stopped whatever its status says', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: inspected({ Running: false, Status: 'running' }) },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'status running',
      state: 'stopped',
    });
  });

  test.each<[boolean, string, ServiceCheckState]>([
    [true, 'status running', 'up'],
    [false, 'status not running', 'stopped'],
  ])('with Running %p and no Status says %p', async (running, detail, state) => {
    const { socket } = await fakeEngine({
      '/containers/web/json': { body: inspected({ Running: running }) },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({ detail, state });
  });

  test('has an exit code only when the status is exited or dead', async () => {
    const { socket } = await fakeEngine({
      '/containers/web/json': {
        body: inspected({ ExitCode: 3, Running: false, Status: 'created' }),
      },
    });

    expect(await checkContainer('web', engineAt(socket))).toEqual({
      detail: 'status created',
      state: 'stopped',
    });
  });
});

const asked = async (result: HttpGetResult) => {
  const calls: Parameters<HttpGet>[] = [];
  const get: HttpGet = (target, options) => {
    calls.push([target, options]);
    return Promise.resolve(result);
  };
  const outcome = await checkContainer('web', {
    endpoint: { kind: 'unix', path: '/run/user/1/docker.sock' },
    get,
  });
  return { calls, outcome };
};

// What the check asks of its transport, and how it reads each way the
// transport can fail, with a fake in its place.
describe('the request the check makes', () => {
  test('is a GET of the encoded container path on the socket, with 5 seconds and a 1 MiB cap', async () => {
    const { calls } = await asked({
      body: JSON.stringify(inspected({ Running: true, Status: 'running' })),
      kind: 'response',
      status: 200,
      truncated: false,
    });

    expect(calls).toEqual([
      [
        { path: '/containers/web/json', socketPath: '/run/user/1/docker.sock' },
        { maxBodyBytes: 1024 * 1024 + 1, timeoutMs: 5000 },
      ],
    ]);
  });

  test.each<[HttpGetResult, string]>([
    [{ kind: 'failed', message: 'x', reason: 'timeout' }, 'Docker timed out'],
    [{ kind: 'failed', message: 'x', reason: 'refused' }, 'Docker socket unreachable'],
    [{ kind: 'failed', message: 'x', reason: 'reset' }, 'Docker connection reset'],
    [{ kind: 'failed', message: 'x', reason: 'invalid response' }, 'unexpected Docker answer'],
    [
      { kind: 'failed', message: 'EACCES: permission denied', reason: 'error' },
      'could not request Docker: EACCES: permission denied',
    ],
  ])('%j is unknown, saying %s', async (result, detail) => {
    const { outcome } = await asked(result);

    expect(outcome).toEqual({ detail, state: 'unknown' });
  });
});

describe('the Engine socket, read from the real environment', () => {
  const keep = { host: process.env.DOCKER_HOST, runtime: process.env.XDG_RUNTIME_DIR };
  afterEach(() => {
    for (const [key, value] of [
      ['DOCKER_HOST', keep.host],
      ['XDG_RUNTIME_DIR', keep.runtime],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('is under /run/user/<the process uid> when the environment names nothing', () => {
    delete process.env.DOCKER_HOST;
    delete process.env.XDG_RUNTIME_DIR;

    expect(dockerEndpoint()).toEqual({
      kind: 'unix',
      path: `/run/user/${String(process.getuid?.())}/docker.sock`,
    });
  });

  test('follows DOCKER_HOST and XDG_RUNTIME_DIR in process.env', () => {
    process.env.DOCKER_HOST = 'unix:///here.sock';
    expect(dockerEndpoint()).toEqual({ kind: 'unix', path: '/here.sock' });

    delete process.env.DOCKER_HOST;
    process.env.XDG_RUNTIME_DIR = '/run/there';
    expect(dockerEndpoint()).toEqual({ kind: 'unix', path: '/run/there/docker.sock' });
  });
});

// The transport uses no proxy: a proxy has no way to reach the socket, and
// would see the request if it were sent there.
test.each(['HTTP_PROXY', 'http_proxy'] as const)(
  'a request over the socket does not go through a proxy the environment names (%s)',
  async (variable) => {
    let proxied = 0;
    const proxy = Bun.serve({
      fetch: () => {
        proxied += 1;
        return new Response('from the proxy');
      },
      port: 0,
    });
    try {
      const { socket } = await fakeEngine({
        '/containers/web/json': { body: inspected({ Running: true, Status: 'running' }) },
      });

      const printed = await runWithProxy({
        proxy: `http://127.0.0.1:${String(proxy.port)}`,
        script: `
          const { checkContainer } = await import(${JSON.stringify(join(import.meta.dir, 'docker.ts'))});
          const { httpGet } = await import(${JSON.stringify(import.meta.resolve('@heimdall/service'))});
          const endpoint = { kind: 'unix', path: ${JSON.stringify(socket)} };
          console.log(JSON.stringify(await checkContainer('web', { endpoint, get: httpGet })));
        `,
        variable,
      });

      expect(JSON.parse(printed)).toMatchObject({ state: 'up' });
      expect(proxied).toBe(0);
    } finally {
      await proxy.stop(true);
    }
  },
);
