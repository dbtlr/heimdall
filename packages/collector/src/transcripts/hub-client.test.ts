import { describe, expect, test } from 'bun:test';

import { unreachableHub } from '../testing/fake-hub.ts';
import { transcriptHub } from './hub-client.ts';

type Seen = { auth: string | null; body: Uint8Array; offset: string | null; path: string };

// A Hub that answers every request with `answer` and records what it was sent.
const hubAnswering = (answer: () => Response) => {
  const seen: Seen[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      seen.push({
        auth: request.headers.get('authorization'),
        body: new Uint8Array(await request.arrayBuffer()),
        offset: request.headers.get('heimdall-offset'),
        path: new URL(request.url).pathname,
      });
      return answer();
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return {
    client: transcriptHub({ hub: new URL(`${server.url.href}prefix`), token: 'tok' }),
    seen,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
};

const json = (status: number, body: unknown) => Response.json(body, { status });
const FILE = { path: 'projects/p/a.jsonl', source: 'claude-code' };

describe('opening a generation', () => {
  test('answers the Hub-numbered generation, sending the file as JSON with the token', async () => {
    await using h = hubAnswering(() => json(201, { generation: 42, held: 0 }));

    expect(await h.client.open(FILE)).toEqual({ generation: 42, held: 0, kind: 'opened' });
    expect(h.seen[0]?.path).toBe('/prefix/api/v1/transcripts/generations');
    expect(h.seen[0]?.auth).toBe('Bearer tok');
    expect(JSON.parse(new TextDecoder().decode(h.seen[0]?.body))).toEqual(FILE);
  });

  test('answers deleted when every generation at the path was deleted', async () => {
    await using h = hubAnswering(() => new Response(null, { status: 410 }));

    expect(await h.client.open(FILE)).toEqual({ kind: 'deleted' });
  });

  test.each([401, 403, 422, 500])('fails on %d', async (status) => {
    await using h = hubAnswering(() => new Response('nope', { status }));

    expect(await h.client.open(FILE)).toEqual({
      kind: 'failed',
      reason: `Hub answered ${String(status)}`,
    });
  });

  test('fails on an answer that is not a generation', async () => {
    await using h = hubAnswering(() => json(201, { generation: 'x' }));

    expect((await h.client.open(FILE)).kind).toBe('failed');
  });

  test('fails when the Hub cannot be reached', async () => {
    const client = transcriptHub({ hub: new URL(unreachableHub()), token: 'tok' });

    expect((await client.open(FILE)).kind).toBe('failed');
  });
});

describe('sending a chunk', () => {
  const body = new Uint8Array([1, 2, 3]);

  test('posts the body at its offset and answers how much the Hub holds', async () => {
    await using h = hubAnswering(() => json(200, { held: 120 }));

    expect(await h.client.send({ body, generation: 42, offset: 100 })).toEqual({
      held: 120,
      kind: 'held',
    });
    expect(h.seen[0]?.path).toBe('/prefix/api/v1/transcripts/generations/42/chunks');
    expect(h.seen[0]?.offset).toBe('100');
    expect(h.seen[0]?.auth).toBe('Bearer tok');
    expect([...(h.seen[0]?.body ?? [])]).toEqual([1, 2, 3]);
  });

  test('answers elsewhere with what the Hub holds when the offset is not its end', async () => {
    await using h = hubAnswering(() => json(409, { held: 7 }));

    expect(await h.client.send({ body, generation: 42, offset: 100 })).toEqual({
      held: 7,
      kind: 'elsewhere',
    });
  });

  test('answers deleted for a generation deleted on purpose', async () => {
    await using h = hubAnswering(() => new Response(null, { status: 410 }));

    expect(await h.client.send({ body, generation: 42, offset: 0 })).toEqual({ kind: 'deleted' });
  });

  test('answers unknown for a generation the Hub does not have', async () => {
    await using h = hubAnswering(() => new Response(null, { status: 404 }));

    expect(await h.client.send({ body, generation: 42, offset: 0 })).toEqual({ kind: 'unknown' });
  });

  test.each([401, 403, 413, 422, 503])('fails on %d', async (status) => {
    await using h = hubAnswering(() => new Response(null, { status }));

    expect((await h.client.send({ body, generation: 42, offset: 0 })).kind).toBe('failed');
  });
});
