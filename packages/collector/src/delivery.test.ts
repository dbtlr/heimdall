import { afterAll, describe, expect, test } from 'bun:test';

import { ReportSchema } from '@heimdall/schema';
import type { Report, TranscriptsSection } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { flushQueue, sendReport } from './delivery.ts';
import type { Delivery } from './delivery.ts';
import { openQueue } from './queue.ts';
import type { SampleQueue } from './queue.ts';
import { tempStateDir } from './testing/fixtures.ts';

const identity = {
  collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
  system: 'laptop-1',
} as const;

const report = (): Report => ({
  ...identity,
  samples: [sample(1000)],
  schemaVersion: 1,
  sentAt: 2000,
});

describe('sending a Report', () => {
  const received: { authorization: string | null; body: unknown; path: string }[] = [];
  let status = 202;
  const hub = Bun.serve({
    fetch: async (request) => {
      received.push({
        authorization: request.headers.get('authorization'),
        body: await request.json(),
        path: new URL(request.url).pathname,
      });
      return new Response('{"error":"bad sample"}', { status });
    },
    port: 0,
  });
  afterAll(() => hub.stop(true));

  test('posts JSON to the ingest endpoint with the bearer token', async () => {
    status = 202;
    const outcome = await sendReport({ hub: hub.url, report: report(), token: 's3cret' });

    expect(outcome).toEqual({ kind: 'delivered' });
    expect(received.at(-1)).toEqual({
      authorization: 'Bearer s3cret',
      body: report(),
      path: '/api/v1/reports',
    });
  });

  test('keeps the path of a Hub served under a prefix', async () => {
    await sendReport({ hub: new URL('/heimdall/', hub.url), report: report(), token: 't' });

    expect(received.at(-1)?.path).toBe('/heimdall/api/v1/reports');
  });

  test('reads 422 as a rejected Report, with the Hub explanation', async () => {
    status = 422;
    const outcome = await sendReport({ hub: hub.url, report: report(), token: 't' });

    expect(outcome).toEqual({ detail: '{"error":"bad sample"}', kind: 'rejected' });
  });

  test('reads a redirect as a failure to retry, not as delivery', async () => {
    const elsewhere = Bun.serve({ fetch: () => new Response('ok'), port: 0 });
    const redirecting = Bun.serve({
      fetch: () => Response.redirect(elsewhere.url.href, 302),
      port: 0,
    });

    const outcome = await sendReport({ hub: redirecting.url, report: report(), token: 't' });
    await Promise.all([elsewhere.stop(true), redirecting.stop(true)]);

    expect(outcome).toEqual({ kind: 'failed', reason: 'Hub answered 302' });
  });

  test.each([401, 403, 429, 500, 503])('reads %i as a failure to retry', async (code) => {
    status = code;
    const outcome = await sendReport({ hub: hub.url, report: report(), token: 't' });

    expect(outcome).toEqual({ kind: 'failed', reason: `Hub answered ${String(code)}` });
  });

  test('reads an unreachable Hub as a failure to retry', async () => {
    const closed = Bun.serve({ fetch: () => new Response(), port: 0 });
    const url = closed.url;
    await closed.stop(true);

    const outcome = await sendReport({ hub: url, report: report(), token: 't' });

    expect(outcome.kind).toBe('failed');
  });
});

// A Hub that answers each Report with the next scripted outcome and records it.
const scriptedHub = (outcomes: Delivery[]) => {
  const reports: Report[] = [];
  const send = (sent: Report) => {
    reports.push(sent);
    return Promise.resolve<Delivery>(outcomes.shift() ?? { kind: 'delivered' });
  };
  return { reports, send };
};

const NO_TRANSCRIPTS = { sources: [], spool: { bytes: 0, oldestAt: null } };

const flush = (
  queue: SampleQueue,
  send: (sent: Report) => Promise<Delivery>,
  transcripts: () => TranscriptsSection = () => NO_TRANSCRIPTS,
) => flushQueue({ batchSize: 2, identity, now: () => 9000, queue, send, transcripts });

describe('flushing the queue', () => {
  test('sends the backlog oldest first in Reports of at most the batch size', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    for (const t of [1000, 2000, 3000, 4000, 5000]) {
      queue.append(sample(t));
    }
    const hub = scriptedHub([]);

    const result = await flush(queue, hub.send);

    expect(hub.reports.map((r) => r.samples.map((s) => s.t))).toEqual([
      [1000, 2000],
      [3000, 4000],
      [5000],
    ]);
    expect(hub.reports.every((r) => ReportSchema.safeParse(r).success)).toBe(true);
    expect(hub.reports[0]).toMatchObject({ ...identity, schemaVersion: 1, sentAt: 9000 });
    expect(result).toEqual({ delivered: 5, kind: 'drained', rejected: [] });
    expect(queue.oldest(10)).toEqual([]);
    queue.close();
  });

  test('every Report carries the transcripts section as it stands when sent', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    for (const t of [1000, 2000, 3000]) {
      queue.append(sample(t));
    }
    const hub = scriptedHub([]);
    let bytes = 300;
    const transcripts = (): TranscriptsSection => {
      bytes -= 100;
      return {
        sources: [{ harness: 'codex', name: 'codex', status: 'capturing' }],
        spool: { bytes, oldestAt: 500 },
      };
    };

    await flush(queue, hub.send, transcripts);

    expect(hub.reports.map((r) => r.transcripts?.spool.bytes)).toEqual([200, 100]);
    expect(hub.reports[0]?.transcripts?.sources).toEqual([
      { harness: 'codex', name: 'codex', status: 'capturing' },
    ]);
    queue.close();
  });

  test('drops a rejected Report and carries on', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    for (const t of [1000, 2000, 3000]) {
      queue.append(sample(t));
    }
    const hub = scriptedHub([{ detail: 'bad', kind: 'rejected' }]);

    const result = await flush(queue, hub.send);

    expect(result).toEqual({
      delivered: 1,
      kind: 'drained',
      rejected: [{ detail: 'bad', samples: 2 }],
    });
    expect(queue.oldest(10)).toEqual([]);
    queue.close();
  });

  test('stops at a failure and keeps the undelivered samples queued', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    for (const t of [1000, 2000, 3000, 4000]) {
      queue.append(sample(t));
    }
    const hub = scriptedHub([
      { kind: 'delivered' },
      { kind: 'failed', reason: 'Hub answered 503' },
    ]);

    const result = await flush(queue, hub.send);

    expect(result).toEqual({
      delivered: 2,
      kind: 'failed',
      reason: 'Hub answered 503',
      rejected: [],
    });
    expect(queue.oldest(10)).toEqual([sample(3000), sample(4000)]);
    queue.close();
  });
});
