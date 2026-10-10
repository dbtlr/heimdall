import { expect, test } from 'bun:test';

import { ReportSchema } from '@heimdall/schema';
import type { Report } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { runCollector } from './collector.ts';
import { sendReport } from './delivery.ts';
import { openQueue } from './queue.ts';
import { NO_SECTIONS, NO_TIME_ZONE, tempStateDir } from './testing/fixtures.ts';

const NO_TRANSCRIPTS = { sources: [], spool: { bytes: 0, oldestAt: null } };

const identity = {
  collector: { arch: 'x64', platform: 'linux', version: '0.0.0' },
  system: 'server-1',
} as const;

// A Hub that records every sample time it accepts, and can go down and come back
// on the same port.
const fakeHub = () => {
  const received: number[] = [];
  const serve = (port = 0) =>
    Bun.serve({
      fetch: async (request) => {
        const report = ReportSchema.parse(await request.json());
        received.push(...report.samples.map((s) => s.t));
        return new Response(null, { status: 202 });
      },
      port,
    });
  let server = serve();
  const url = server.url;
  return {
    received,
    restart: () => {
      server = serve(Number(url.port));
    },
    stop: () => server.stop(true),
    url,
  };
};

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling a live loop.
    await Bun.sleep(5);
  }
};

test('samples taken while the Hub is down arrive once it is back, each once', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 1000, stateDir: dir.path });
  const hub = fakeHub();
  const sampled: number[] = [];
  const logs: string[] = [];
  const controller = new AbortController();

  const running = runCollector({
    identity,
    intervalMs: 10,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    maxBackoffMs: 30,
    queue,
    sampler: {
      sample: () => {
        sampled.push(sampled.length + 1);
        return Promise.resolve(sample(sampled.length));
      },
    },
    sections: NO_SECTIONS,
    send: (report) => sendReport({ hub: hub.url, report, token: 't' }),
    signal: controller.signal,
    timeZone: NO_TIME_ZONE,
    transcripts: () => NO_TRANSCRIPTS,
  });

  await until(() => hub.received.length >= 3);
  await hub.stop();
  const takenBeforeOutage = sampled.length;
  await until(() => sampled.length >= takenBeforeOutage + 10);
  const takenDuringOutage = sampled.slice(takenBeforeOutage);
  hub.restart();
  await until(() => takenDuringOutage.every((t) => hub.received.includes(t)));
  controller.abort();
  await running;
  await hub.stop();
  queue.close();

  expect(new Set(hub.received).size).toBe(hub.received.length);
  expect(hub.received).toEqual(hub.received.toSorted((a, b) => a - b));
  expect(logs.filter((l) => l.startsWith('warn Pushing to the Hub failed'))).toHaveLength(1);
  expect(logs.filter((l) => l.startsWith('info Pushing to the Hub works again'))).toHaveLength(1);
});

test('every Report it sends carries the time zone its dependency gives', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  const controller = new AbortController();
  const reports: Report[] = [];
  let taken = 0;

  const running = runCollector({
    identity,
    intervalMs: 5,
    log: { info: () => 0, warn: () => 0 },
    maxBackoffMs: 5,
    queue,
    sampler: {
      sample: () => {
        taken += 1;
        return Promise.resolve(sample(taken));
      },
    },
    sections: NO_SECTIONS,
    send: (report) => {
      reports.push(report);
      return Promise.resolve({ kind: 'delivered' });
    },
    signal: controller.signal,
    timeZone: () => 'Europe/Paris',
    transcripts: () => NO_TRANSCRIPTS,
  });
  await until(() => reports.length >= 2);
  controller.abort();
  await running;
  queue.close();

  expect(reports.slice(0, 2).map((report) => report.timeZone)).toEqual([
    'Europe/Paris',
    'Europe/Paris',
  ]);
});

test('stops between samples when its signal aborts', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  const controller = new AbortController();
  let taken = 0;

  const running = runCollector({
    identity,
    intervalMs: 60_000,
    log: { info: () => 0, warn: () => 0 },
    maxBackoffMs: 60_000,
    queue,
    sampler: {
      sample: () => {
        taken += 1;
        return Promise.resolve(sample(taken));
      },
    },
    sections: NO_SECTIONS,
    send: () => Promise.resolve({ kind: 'delivered' }),
    signal: controller.signal,
    timeZone: NO_TIME_ZONE,
    transcripts: () => NO_TRANSCRIPTS,
  });
  controller.abort();
  await running;
  queue.close();

  expect(taken).toBe(0);
});

test('a sample that fails is skipped with a warning and collection carries on', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  const controller = new AbortController();
  const warnings: string[] = [];
  let attempts = 0;
  const delivered: number[] = [];

  const running = runCollector({
    identity,
    intervalMs: 5,
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    maxBackoffMs: 5,
    queue,
    sampler: {
      sample: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('vm_stat exited 1'))
          : Promise.resolve(sample(attempts));
      },
    },
    sections: NO_SECTIONS,
    send: (report) => {
      delivered.push(...report.samples.map((s) => s.t));
      return Promise.resolve({ kind: 'delivered' });
    },
    signal: controller.signal,
    timeZone: NO_TIME_ZONE,
    transcripts: () => NO_TRANSCRIPTS,
  });
  await until(() => delivered.length >= 2);
  controller.abort();
  await running;
  queue.close();

  expect(warnings).toEqual(['Could not sample this System: vm_stat exited 1']);
  expect(delivered.slice(0, 2)).toEqual([2, 3]);
});

test('a slow push does not crowd the next sample', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  const controller = new AbortController();
  const sampledAt: number[] = [];
  let sends = 0;

  const running = runCollector({
    identity,
    intervalMs: 40,
    log: { info: () => 0, warn: () => 0 },
    queue,
    sampler: {
      sample: () => {
        sampledAt.push(performance.now());
        return Promise.resolve(sample(sampledAt.length));
      },
    },
    sections: NO_SECTIONS,
    send: async () => {
      sends += 1;
      // The first push takes three intervals.
      await Bun.sleep(sends === 1 ? 120 : 0);
      return { kind: 'delivered' };
    },
    signal: controller.signal,
    timeZone: NO_TIME_ZONE,
    transcripts: () => NO_TRANSCRIPTS,
  });
  await until(() => sampledAt.length >= 4);
  controller.abort();
  await running;
  queue.close();

  const gaps = sampledAt.slice(1).map((at, i) => at - (sampledAt[i] ?? at));
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(35);
});

test('a queue error warns and backs off instead of stopping the Collector', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  const controller = new AbortController();
  const warnings: string[] = [];
  let failures = 1;
  const delivered: number[] = [];
  let taken = 0;

  const running = runCollector({
    identity,
    intervalMs: 5,
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    maxBackoffMs: 5,
    queue: {
      ...queue,
      oldest: (limit) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return queue.oldest(limit);
      },
    },
    sampler: {
      sample: () => {
        taken += 1;
        return Promise.resolve(sample(taken));
      },
    },
    sections: NO_SECTIONS,
    send: (report) => {
      delivered.push(...report.samples.map((s) => s.t));
      return Promise.resolve({ kind: 'delivered' });
    },
    signal: controller.signal,
    timeZone: NO_TIME_ZONE,
    transcripts: () => NO_TRANSCRIPTS,
  });
  await until(() => delivered.includes(1));
  controller.abort();
  await running;
  queue.close();

  expect(warnings).toEqual([
    'Pushing to the Hub failed (SQLITE_BUSY: database is locked); samples stay queued.',
  ]);
});
