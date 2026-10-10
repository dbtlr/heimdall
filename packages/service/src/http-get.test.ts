import { afterEach, describe, expect, test } from 'bun:test';

import { httpGet } from './http-get.ts';

const stoppers: (() => unknown)[] = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) {
    void stop();
  }
});

// A loopback HTTP server answering with `handler`; it is stopped after the test.
const serve = (handler: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
  stoppers.push(() => server.stop(true));
  return { host: '127.0.0.1', port: server.port ?? 0 };
};

// A TCP listener that handles a connection with `onConnect`, for answers no
// HTTP server would give.
const listen = (
  onConnect: (socket: {
    end: (data?: string) => unknown;
    terminate: () => void;
    write: (data: string) => unknown;
  }) => void,
) => {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => undefined, open: onConnect },
  });
  stoppers.push(() => listener.stop(true));
  return { host: '127.0.0.1', port: listener.port };
};

const OPTIONS = { maxBodyBytes: 1024, timeoutMs: 2000 };

// A body that never ends, sending a kilobyte every few milliseconds.
const endless = () => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    cancel: () => {
      state.cancelled = true;
    },
    pull: async (controller) => {
      await Bun.sleep(5);
      controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
    },
  });
  return { body, state };
};

describe('httpGet', () => {
  test('answers the status and body of a GET', async () => {
    const target = serve((request) => new Response(`hello ${new URL(request.url).pathname}`));

    expect(await httpGet({ ...target, path: '/hi?a=1' }, OPTIONS)).toEqual({
      body: 'hello /hi',
      kind: 'response',
      status: 200,
      truncated: false,
    });
  });

  test('answers a non-2xx status as a response, not a failure', async () => {
    const target = serve(() => new Response('no', { status: 503 }));

    expect(await httpGet({ ...target, path: '/' }, OPTIONS)).toMatchObject({
      kind: 'response',
      status: 503,
    });
  });

  test('does not follow a redirect', async () => {
    const elsewhere = serve(() => new Response('elsewhere'));
    const seen: number[] = [];
    const target = serve(() => {
      seen.push(1);
      return new Response(null, {
        headers: { location: `http://${elsewhere.host}:${String(elsewhere.port)}/away` },
        status: 302,
      });
    });

    expect(await httpGet({ ...target, path: '/' }, OPTIONS)).toMatchObject({
      kind: 'response',
      status: 302,
    });
  });

  test('reads from a unix socket', async () => {
    const socketPath = `/tmp/heimdall-http-get-${String(process.pid)}-${String(Date.now())}.sock`;
    const server = Bun.serve({ fetch: () => new Response('over a socket'), unix: socketPath });
    stoppers.push(() => server.stop(true));

    expect(await httpGet({ path: '/v1/x', socketPath }, OPTIONS)).toMatchObject({
      body: 'over a socket',
      kind: 'response',
      status: 200,
    });
  });

  test('reads no body when the cap is zero, and closes the connection', async () => {
    const { body, state } = endless();
    const target = serve(() => new Response(body));

    expect(await httpGet({ ...target, path: '/' }, { ...OPTIONS, maxBodyBytes: 0 })).toEqual({
      body: '',
      kind: 'response',
      status: 200,
      truncated: true,
    });
    await Bun.sleep(50);
    expect(state.cancelled).toBe(true);
  });

  test('stops reading an endless body at the cap and closes the connection', async () => {
    const { body, state } = endless();
    const target = serve(() => new Response(body));

    const result = await httpGet({ ...target, path: '/' }, { ...OPTIONS, maxBodyBytes: 100 });

    expect(result).toMatchObject({ kind: 'response', status: 200, truncated: true });
    expect(result.kind === 'response' && result.body.length).toBe(100);
    await Bun.sleep(50);
    expect(state.cancelled).toBe(true);
  });

  test('fails as a timeout when the handler does not answer in time', async () => {
    const target = serve(() => Promise.withResolvers<Response>().promise);
    const started = performance.now();

    const result = await httpGet({ ...target, path: '/' }, { ...OPTIONS, timeoutMs: 100 });

    expect(result).toMatchObject({ kind: 'failed', reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('fails as a timeout when the body does not end in time, and not at the cap', async () => {
    const { body } = endless();
    const target = serve(() => new Response(body));

    const result = await httpGet(
      { ...target, path: '/' },
      { maxBodyBytes: 10_000_000, timeoutMs: 150 },
    );

    expect(result).toMatchObject({ kind: 'failed', reason: 'timeout' });
  });

  test('fails as refused when nothing listens on the port', async () => {
    const server = Bun.serve({ fetch: () => new Response(''), hostname: '127.0.0.1', port: 0 });
    const port = server.port ?? 0;
    await server.stop(true);

    expect(await httpGet({ host: '127.0.0.1', path: '/', port }, OPTIONS)).toMatchObject({
      kind: 'failed',
      reason: 'refused',
    });
  });

  test('fails as refused when no socket exists at the path', async () => {
    expect(
      await httpGet({ path: '/', socketPath: '/tmp/heimdall-no-such.sock' }, OPTIONS),
    ).toMatchObject({ kind: 'failed', reason: 'refused' });
  });

  test('fails as reset when the connection is reset before an answer', async () => {
    const target = listen((socket) => {
      socket.terminate();
    });

    expect(await httpGet({ ...target, path: '/' }, OPTIONS)).toMatchObject({
      kind: 'failed',
      reason: 'reset',
    });
  });

  test('fails as reset when the connection closes in the middle of the body', async () => {
    const target = listen((socket) => {
      socket.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nshort');
      socket.end();
    });

    expect(await httpGet({ ...target, path: '/' }, OPTIONS)).toMatchObject({
      kind: 'failed',
      reason: 'reset',
    });
  });

  test('fails as an invalid response when the answer is not HTTP', async () => {
    const target = listen((socket) => {
      socket.end('this is not http\r\n\r\n');
    });

    expect(await httpGet({ ...target, path: '/' }, OPTIONS)).toMatchObject({
      kind: 'failed',
      reason: 'invalid response',
    });
  });

  test('fails as an invalid response when the server switches protocols', async () => {
    const target = listen((socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
      );
    });

    expect(await httpGet({ ...target, path: '/' }, OPTIONS)).toMatchObject({
      kind: 'failed',
      reason: 'invalid response',
    });
  });

  test('fails as a local error, not a connection failure, when the request cannot be made', async () => {
    expect(await httpGet({ host: '127.0.0.1', path: '/', port: 70_000 }, OPTIONS)).toMatchObject({
      kind: 'failed',
      reason: 'error',
    });
  });

  describe('with a proxy in the environment', () => {
    const saved = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
    };

    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });

    test.each(['HTTP_PROXY', 'http_proxy'])(
      '%s is ignored: the request reaches the target directly',
      async (name) => {
        const proxied: string[] = [];
        const proxy = serve((request) => {
          proxied.push(request.url);
          return new Response('from the proxy');
        });
        const target = serve(() => new Response('from the target'));
        process.env[name] = `http://user:secret@${proxy.host}:${String(proxy.port)}`;

        const result = await httpGet({ ...target, path: '/' }, OPTIONS);

        expect(result).toMatchObject({ body: 'from the target', status: 200 });
        expect(proxied).toEqual([]);
      },
    );
  });
});
