import { expect, test } from 'bun:test';

import type { SentServiceStop } from '@heimdall/schema';

import { storeReport } from './store.ts';
import { NOW, report, startHub } from './testing/hub.ts';

const STOP: SentServiceStop = {
  exitStatus: 0,
  ongoing: false,
  restarts: 0,
  result: 'success',
  service: 'web',
  startedAt: NOW - 30_000,
  stoppedAt: NOW - 60_000,
};

test('a Report stores its Service stops with the sent and received times', async () => {
  await using h = await startHub();
  await storeReport(h.db.sql, {
    receivedAt: NOW + 1000,
    report: { ...report('laptop-1', []), serviceStops: { stops: [STOP] } },
  });

  expect(await h.db.sql<Record<string, unknown>[]>`SELECT * FROM service_stops`).toEqual([
    {
      exit_status: 0,
      ongoing: false,
      received_at: new Date(NOW + 1000),
      restarts: 0,
      result: 'success',
      sent_at: new Date(NOW),
      service: 'web',
      started_at: new Date(NOW - 30_000),
      stopped_at: new Date(NOW - 60_000),
      system: 'laptop-1',
    },
  ]);
});

test('an ended stop replaces its ongoing view, including null results and an unknown end', async () => {
  await using h = await startHub();
  const send = (stop: SentServiceStop, sentAt: number) =>
    storeReport(h.db.sql, {
      receivedAt: sentAt,
      report: { ...report('laptop-1', []), sentAt, serviceStops: { stops: [stop] } },
    });
  await send({ ...STOP, ongoing: true, restarts: 1, startedAt: null }, NOW);
  await send({ ...STOP, exitStatus: null, restarts: 3, result: null, startedAt: null }, NOW + 1000);

  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT ongoing, started_at, restarts, result, exit_status FROM service_stops`,
  ).toEqual([{ exit_status: null, ongoing: false, restarts: 3, result: null, started_at: null }]);
});

test('an older Report cannot replace a newer view of the same stop', async () => {
  await using h = await startHub();
  await storeReport(h.db.sql, {
    receivedAt: NOW + 1000,
    report: { ...report('laptop-1', []), sentAt: NOW + 1000, serviceStops: { stops: [STOP] } },
  });
  await storeReport(h.db.sql, {
    receivedAt: NOW + 2000,
    report: {
      ...report('laptop-1', []),
      serviceStops: { stops: [{ ...STOP, ongoing: true, startedAt: null }] },
    },
  });

  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT ongoing, started_at, sent_at, received_at FROM service_stops`,
  ).toEqual([
    {
      ongoing: false,
      received_at: new Date(NOW + 1000),
      sent_at: new Date(NOW + 1000),
      started_at: new Date(STOP.startedAt ?? 0),
    },
  ]);
});

test('a corrected clock replaces a future-dated view, and a full batch stores every stop', async () => {
  await using h = await startHub();
  await storeReport(h.db.sql, {
    receivedAt: NOW,
    report: {
      ...report('laptop-1', []),
      sentAt: NOW + 60_000,
      serviceStops: { stops: [{ ...STOP, ongoing: true, startedAt: null }] },
    },
  });
  await storeReport(h.db.sql, {
    receivedAt: NOW + 1000,
    report: {
      ...report('laptop-1', []),
      serviceStops: {
        stops: Array.from({ length: 1000 }, (_, i) => ({
          ...STOP,
          stoppedAt: STOP.stoppedAt - i * 1000,
        })),
      },
    },
  });

  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT count(*)::integer AS count FROM service_stops`,
  ).toEqual([{ count: 1000 }]);
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT ongoing FROM service_stops WHERE stopped_at = ${new Date(STOP.stoppedAt)}`,
  ).toEqual([{ ongoing: false }]);
});

test('Service stop times preserve milliseconds across the wire timestamp range', async () => {
  await using h = await startHub();
  const early = Date.UTC(10_000, 0, 1) + 1;
  const late = 8_640_000_000_000_000;
  await storeReport(h.db.sql, {
    receivedAt: NOW,
    report: {
      ...report('laptop-1', []),
      serviceStops: { stops: [{ ...STOP, startedAt: late, stoppedAt: early }] },
    },
  });

  const times: { stopped_at: Date; started_at: Date }[] = await h.db
    .sql`SELECT stopped_at, started_at FROM service_stops`;
  expect(times.map((row) => [row.stopped_at.getTime(), row.started_at.getTime()])).toEqual([
    [early, late],
  ]);
});
