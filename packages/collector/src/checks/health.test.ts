import { afterEach, describe, expect, test } from 'bun:test';

import { httpGet } from '@heimdall/service';
import type { HttpGet, HttpGetResult } from '@heimdall/service';

import { checkHealth } from './health.ts';

const stoppers: (() => unknown)[] = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) {
    void stop();
  }
});

// A loopback server that answers every request with `handler`, and the URL it
// listens on. Paths the handler saw are listed in `seen`.
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
  stoppers.push(() => server.stop(true));
  return { seen, url: `http://127.0.0.1:${String(server.port)}` };
};

// A `get` that answers `result`, noting what it was asked.
const answering = (result: HttpGetResult) => {
  const asked: Parameters<HttpGet>[] = [];
  const get: HttpGet = (target, options) => {
    asked.push([target, options]);
    return Promise.resolve(result);
  };
  return { asked, get };
};

const response = (status: number): HttpGetResult => ({
  body: '',
  kind: 'response',
  status,
  truncated: true,
});

describe('a health check', () => {
  test('is up on a 200', async () => {
    const { url } = serve(() => new Response('ok'));

    expect(await checkHealth(`${url}/healthz`, { get: httpGet })).toEqual({
      check: 'health',
      detail: 'HTTP 200',
      state: 'up',
    });
  });

  test('requests the path and query the record names, from the address it names', async () => {
    const { seen, url } = serve(() => new Response('ok'));

    await checkHealth(`${url}/healthz?deep=1`, { get: httpGet });

    expect(seen).toEqual(['/healthz']);
  });

  test('requests an IPv6 loopback URL by its address', async () => {
    const { asked, get } = answering(response(200));

    await checkHealth('http://[::1]:8080/healthz?x=1', { get });

    expect(asked[0]?.[0]).toEqual({ host: '::1', path: '/healthz?x=1', port: 8080 });
  });

  test('reads no body, and gives the request 5 seconds', async () => {
    const { asked, get } = answering(response(200));

    await checkHealth('http://127.0.0.1:8080/', { get });

    expect(asked[0]?.[1]).toEqual({ maxBodyBytes: 0, timeoutMs: 5000 });
  });

  test.each<[number, 'unhealthy' | 'up']>([
    [199, 'unhealthy'],
    [399, 'up'],
    [400, 'unhealthy'],
  ])('a status of %i is %s', async (status, state) => {
    const { get } = answering(response(status));

    expect(await checkHealth('http://127.0.0.1:8080/', { get })).toEqual({
      check: 'health',
      detail: `HTTP ${String(status)}`,
      state,
    });
  });

  test('is unhealthy when the handler outlives the timeout', async () => {
    const { url } = serve(() => Promise.withResolvers<Response>().promise);

    expect(await checkHealth(`${url}/`, { get: httpGet, timeoutMs: 100 })).toEqual({
      check: 'health',
      detail: 'timed out after 0.1 s',
      state: 'unhealthy',
    });
  });

  test('is unhealthy when nothing listens on the port', async () => {
    const server = Bun.serve({ fetch: () => new Response(''), hostname: '127.0.0.1', port: 0 });
    const port = server.port ?? 0;
    await server.stop(true);

    expect(await checkHealth(`http://127.0.0.1:${String(port)}/`, { get: httpGet })).toEqual({
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
    stoppers.push(() => listener.stop(true));

    expect(
      await checkHealth(`http://127.0.0.1:${String(listener.port)}/`, { get: httpGet }),
    ).toEqual({ check: 'health', detail: 'connection reset', state: 'unhealthy' });
  });

  test('is unhealthy when the answer is not HTTP', async () => {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data: () => undefined,
        open: (socket) => {
          socket.end('not http\r\n\r\n');
        },
      },
    });
    stoppers.push(() => listener.stop(true));

    expect(
      await checkHealth(`http://127.0.0.1:${String(listener.port)}/`, { get: httpGet }),
    ).toEqual({ check: 'health', detail: 'invalid response', state: 'unhealthy' });
  });

  test('is unknown, not unhealthy, when the Collector itself cannot make the request', async () => {
    const { get } = answering({
      kind: 'failed',
      message: 'EMFILE: too many open files',
      reason: 'error',
    });

    expect(await checkHealth('http://127.0.0.1:8080/', { get })).toEqual({
      check: 'health',
      detail: 'could not request: EMFILE: too many open files',
      state: 'unknown',
    });
  });

  test('takes control characters out of a detail', async () => {
    const { get } = answering({ kind: 'failed', message: 'bad\0 \u001B[31mname', reason: 'error' });

    expect((await checkHealth('http://127.0.0.1:8080/', { get })).detail).toBe(
      'could not request: bad [31mname',
    );
  });
});
