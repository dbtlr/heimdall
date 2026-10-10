import { afterAll, describe, expect, test } from 'bun:test';

import {
  MAX_RECORDS_SECTION_BYTES,
  MAX_REPORT_BYTES,
  MAX_RUNS_SECTION_BYTES,
  ReportSchema,
} from '@heimdall/schema';
import type { Report, TranscriptsSection } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { flushQueue, sendReport } from './delivery.ts';
import type { Delivery } from './delivery.ts';
import { openQueue } from './queue.ts';
import type { SampleQueue } from './queue.ts';
import { NO_SECTIONS, NO_TIME_ZONE, tempStateDir } from './testing/fixtures.ts';

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

// Rows of about 1 KiB of JSON each, enough of them to fill a section to `bytes`.
const refs = (bytes: number) => {
  const name = 'n'.repeat(1000);
  return Array.from({ length: Math.floor(bytes / 1100) }, () => ({ kind: 'service', name }));
};

const NO_TRANSCRIPTS = { sources: [], spool: { bytes: 0, oldestAt: null } };

const flush = (
  queue: SampleQueue,
  send: (sent: Report) => Promise<Delivery>,
  transcripts: () => TranscriptsSection = () => NO_TRANSCRIPTS,
) =>
  flushQueue({
    batchSize: 2,
    identity,
    now: () => 9000,
    queue,
    sections: NO_SECTIONS,
    send,
    timeZone: NO_TIME_ZONE,
    transcripts,
  });

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

  test('resends the samples of a Report refused with records and runs sections, without either, and settles both', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    queue.append(sample(1000));
    const hub = scriptedHub([
      { detail: 'bad sections', kind: 'rejected' },
      { kind: 'failed', reason: 'Hub answered 503' },
    ]);
    const settled: string[] = [];
    const settle = (name: string) => (outcome: { kind: string }) =>
      settled.push(`${name} ${outcome.kind}`);
    const sections = {
      pending: () =>
        Promise.resolve({
          records: { section: { records: [], unreadable: [] }, settle: settle('records') },
          runs: { section: { jobs: [], unreadable: [] }, settle: settle('runs') },
        }),
    };

    const result = await flushQueue({
      identity,
      now: () => 9000,
      queue,
      sections,
      send: hub.send,
      timeZone: NO_TIME_ZONE,
      transcripts: () => NO_TRANSCRIPTS,
    });

    expect(hub.reports.map((r) => [r.records !== undefined, r.runs !== undefined])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(hub.reports[1]?.samples).toEqual(hub.reports[0]?.samples);
    expect(settled).toEqual(['records rejected', 'runs rejected']);
    expect(result).toEqual({
      delivered: 0,
      kind: 'failed',
      reason: 'Hub answered 503',
      rejected: [],
    });
    expect(queue.oldest(10)).toEqual([sample(1000)]);
    queue.close();
  });

  test('a section that rides alone is carried, and the other is left out', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    for (const t of [1000, 2000, 3000]) {
      queue.append(sample(t));
    }
    const hub = scriptedHub([]);
    const settled: string[] = [];
    const sections = {
      pending: () =>
        Promise.resolve({
          runs: {
            section: { jobs: [], unreadable: [] },
            settle: (outcome: { kind: string }) => settled.push(outcome.kind),
          },
        }),
    };

    await flushQueue({
      batchSize: 1,
      identity,
      now: () => 9000,
      queue,
      sections,
      send: hub.send,
      timeZone: NO_TIME_ZONE,
      transcripts: () => NO_TRANSCRIPTS,
    });

    // Only the first Report of the flush carries the sections.
    expect(hub.reports.map((r) => [r.records !== undefined, r.runs !== undefined])).toEqual([
      [false, true],
      [false, false],
      [false, false],
    ]);
    expect(settled).toEqual(['delivered']);
    queue.close();
  });

  // 1,000 samples of 60 disks each, with the largest sections a Collector may
  // send, come to more than the Hub reads.
  test('a Report that would exceed the Hub cap goes without its sections, which stay pending for a smaller one', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 2000, stateDir: dir.path });
    const disks = Array.from({ length: 60 }, (_, i) => ({
      mount: `/mnt/disk-${String(i)}`,
      totalBytes: 994_662_584_320,
      usedBytes: 412_316_860_416,
    }));
    for (let t = 1; t <= 1001; t += 1) {
      queue.append({ ...sample(t), disks });
    }
    const hub = scriptedHub([]);
    const settled: string[] = [];
    let asked = 0;
    const sections = {
      pending: () => {
        asked += 1;
        return Promise.resolve({
          records: {
            section: { records: [], unreadable: refs(MAX_RECORDS_SECTION_BYTES) },
            settle: () => settled.push('records'),
          },
          runs: {
            section: { jobs: [], unreadable: refs(MAX_RUNS_SECTION_BYTES).map(({ name }) => name) },
            settle: () => settled.push('runs'),
          },
        });
      },
    };

    await flushQueue({
      identity,
      now: () => 9000,
      queue,
      sections,
      send: hub.send,
      timeZone: NO_TIME_ZONE,
      transcripts: () => NO_TRANSCRIPTS,
    });

    const sizes = hub.reports.map((r) => Buffer.byteLength(JSON.stringify(r)));
    expect(hub.reports.map((r) => r.samples.length)).toEqual([1000, 1]);
    expect(hub.reports.map((r) => [r.records !== undefined, r.runs !== undefined])).toEqual([
      [false, false],
      [true, true],
    ]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(asked).toBe(1);
    expect(settled).toEqual(['records', 'runs']);
    queue.close();
  });

  test('a section a Report is too large to carry is not settled', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    queue.append(sample(1000));
    const hub = scriptedHub([]);
    const settled: string[] = [];
    const sections = {
      pending: () =>
        Promise.resolve({
          records: {
            section: {
              records: [],
              unreadable: Array.from({ length: 14_000 }, () => ({
                kind: 'service',
                name: 'n'.repeat(1000),
              })),
            },
            settle: () => settled.push('records'),
          },
        }),
    };

    await flushQueue({
      identity,
      now: () => 9000,
      queue,
      sections,
      send: hub.send,
      timeZone: NO_TIME_ZONE,
      transcripts: () => NO_TRANSCRIPTS,
    });

    expect(hub.reports.map((r) => r.records)).toEqual([undefined]);
    expect(settled).toEqual([]);
    queue.close();
  });

  test('every Report carries the time zone when there is one, and none when there is not', async () => {
    await using dir = await tempStateDir();
    const queue = await openQueue({ capacity: 10, stateDir: dir.path });
    for (const t of [1000, 2000, 3000]) {
      queue.append(sample(t));
    }
    const withZone = scriptedHub([]);
    const withoutZone = scriptedHub([]);

    await flushQueue({
      batchSize: 2,
      identity,
      now: () => 9000,
      queue,
      sections: NO_SECTIONS,
      send: withZone.send,
      timeZone: () => 'Europe/Paris',
      transcripts: () => NO_TRANSCRIPTS,
    });
    queue.append(sample(4000));
    await flush(queue, withoutZone.send);

    expect(withZone.reports.map((r) => r.timeZone)).toEqual(['Europe/Paris', 'Europe/Paris']);
    expect(withoutZone.reports.map((r) => 'timeZone' in r)).toEqual([false]);
    expect(withZone.reports.every((r) => ReportSchema.safeParse(r).success)).toBe(true);
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
