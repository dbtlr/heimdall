import { afterEach, describe, expect, test } from 'bun:test';

import { MAX_CHECK_DETAIL_LENGTH } from '@heimdall/schema';

import { checkHealth } from './health.ts';

const servers: { stop: (force: boolean) => unknown }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    void server.stop(true);
  }
});

// A loopback server that answers every request with `handler`, and the URL it
// listens on. Requests the handler saw are listed in `seen`.
const serve = (handler: (request: Request) => Response | Promise<Response>) => {
  const seen: string[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      seen.push(new URL(request.url).pathname);
      return handler(request);
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${String(server.port)}` };
};

describe('a health check', () => {
  test('is up on a 200', async () => {
    const { url } = serve(() => new Response('ok'));

    expect(await checkHealth(`${url}/healthz`)).toEqual({
      check: 'health',
      detail: 'HTTP 200',
      state: 'up',
    });
  });

  test('requests the path the record names', async () => {
    const { seen, url } = serve(() => new Response('ok'));

    await checkHealth(`${url}/healthz?deep=1`);

    expect(seen).toEqual(['/healthz']);
  });

  test('is up on a 302, which it does not follow', async () => {
    const elsewhere = serve(() => new Response('elsewhere'));
    const { url } = serve(
      () => new Response(null, { headers: { location: `${elsewhere.url}/away` }, status: 302 }),
    );

    expect(await checkHealth(`${url}/healthz`)).toEqual({
      check: 'health',
      detail: 'HTTP 302',
      state: 'up',
    });
    expect(elsewhere.seen).toEqual([]);
  });

  test('is unhealthy on a 503', async () => {
    const { url } = serve(() => new Response('down', { status: 503 }));

    expect(await checkHealth(`${url}/`)).toEqual({
      check: 'health',
      detail: 'HTTP 503',
      state: 'unhealthy',
    });
  });

  test('is unhealthy on a 404', async () => {
    const { url } = serve(() => new Response('no', { status: 404 }));

    expect((await checkHealth(`${url}/`)).state).toBe('unhealthy');
  });

  test('is unhealthy when the handler outlives the timeout', async () => {
    const { url } = serve(() => Promise.withResolvers<Response>().promise);

    expect(await checkHealth(`${url}/`, { timeoutMs: 100 })).toEqual({
      check: 'health',
      detail: 'timed out after 0.1 s',
      state: 'unhealthy',
    });
  });

  test('says the 5 s default in whole seconds', async () => {
    const outcome = await checkHealth('http://127.0.0.1:1/', {
      request: () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    });

    expect(outcome.detail).toBe('timed out after 5 s');
  });

  test('is unhealthy when nothing listens on the port', async () => {
    const server = Bun.serve({ fetch: () => new Response(''), hostname: '127.0.0.1', port: 0 });
    const { port } = server;
    await server.stop(true);

    expect(await checkHealth(`http://127.0.0.1:${String(port)}/`)).toEqual({
      check: 'health',
      detail: 'connection refused',
      state: 'unhealthy',
    });
  });

  test('is unhealthy when the connection is reset', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data: () => undefined,
        open: (socket) => {
          socket.terminate();
        },
      },
    });
    try {
      expect(await checkHealth(`http://127.0.0.1:${String(listener.port)}/`)).toEqual({
        check: 'health',
        detail: 'connection reset',
        state: 'unhealthy',
      });
    } finally {
      listener.stop(true);
    }
  });

  test('cuts a long failure to what the Hub takes', async () => {
    const outcome = await checkHealth('http://127.0.0.1:1/', {
      request: () => Promise.reject(new Error('x'.repeat(1000))),
    });

    expect(outcome.state).toBe('unhealthy');
    expect(outcome.detail.length).toBeLessThanOrEqual(MAX_CHECK_DETAIL_LENGTH);
  });

  test('does not read the body of the answer', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => {
        cancelled = true;
      },
      pull: () => Promise.withResolvers<void>().promise,
    });

    const outcome = await checkHealth('http://127.0.0.1:1/', {
      request: () => Promise.resolve(new Response(body, { status: 200 })),
    });

    expect(outcome.state).toBe('up');
    expect(cancelled).toBe(true);
  });
});
