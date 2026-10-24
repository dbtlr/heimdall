import { expect, test } from 'bun:test';

import type { SentServiceStop } from '@heimdall/schema';

import { evaluateConditions } from './evaluate-conditions.ts';
import { evaluateServiceStopConditions } from './service-stop-conditions.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STOP: SentServiceStop = {
  exitStatus: 0,
  ongoing: false,
  restarts: 0,
  result: 'success',
  service: 'web',
  startedAt: NOW - 30_000,
  stoppedAt: NOW - 60_000,
};

const send = async (h: Hub, stops: SentServiceStop[], sentAt = NOW) => {
  h.clock.now = sentAt;
  const response = await push(
    h.hub,
    {
      ...report('laptop-1', [sentAt]),
      checks: { services: [] },
      sentAt,
      serviceStops: { stops },
    },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);
};

const evaluate = async (h: Hub, now = NOW) => {
  await evaluateServiceStopConditions(h.db.sql, () => now);
  const rows: { kind: string; subject: string; level: string; reason: string }[] = await h.db
    .sql`SELECT kind, subject, level, latest_reason AS reason FROM conditions WHERE cleared_at IS NULL ORDER BY system, subject`;
  return rows.map(({ kind, level, reason, subject }) => ({ kind, level, reason, subject }));
};

test('one Service stop raises a note naming the stop and its clean result', async () => {
  await using h = await startHub();
  await send(h, [STOP]);

  expect(await evaluate(h)).toEqual([
    {
      kind: 'service_restarted',
      level: 'note',
      reason: 'The Service stopped once at 2026-10-06 11:59 UTC. It last stopped cleanly.',
      subject: 'web',
    },
  ]);
});

test('a System that sent stops but never checks still raises the note', async () => {
  await using h = await startHub();
  h.clock.now = NOW;
  const response = await push(
    h.hub,
    { ...report('laptop-1', [NOW]), sentAt: NOW, serviceStops: { stops: [STOP] } },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);

  expect(await evaluate(h)).toMatchObject([{ kind: 'service_restarted', subject: 'web' }]);
});

test('a second stop updates the count and times without another Timeline transition', async () => {
  await using h = await startHub();
  await send(h, [STOP]);
  await evaluate(h);
  await send(
    h,
    [{ ...STOP, startedAt: NOW + HOUR + 30_000, stoppedAt: NOW + HOUR }],
    NOW + 2 * HOUR,
  );

  expect(await evaluate(h, NOW + 2 * HOUR)).toMatchObject([
    {
      level: 'note',
      reason:
        'The Service stopped 2 times, first at 2026-10-06 11:59 UTC and last at 2026-10-06 13:00 UTC. It last stopped cleanly.',
    },
  ]);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT action, level FROM condition_transitions`,
  ).toEqual([{ action: 'raised', level: 'note' }]);
});

test('the note clears at 24 hours after the latest stop on the Hub clock, without another Report', async () => {
  await using h = await startHub();
  await send(h, [STOP]);
  await evaluate(h);

  expect(await evaluate(h, STOP.stoppedAt + DAY - 1)).toHaveLength(1);
  expect(await evaluate(h, STOP.stoppedAt + DAY)).toEqual([]);
  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT action, level FROM condition_transitions ORDER BY id`,
  ).toEqual([
    { action: 'raised', level: 'note' },
    { action: 'cleared', level: 'note' },
  ]);
});

test('a stop five days ahead names the reported time and clears 24 hours after receipt', async () => {
  await using h = await startHub();
  await send(h, [{ ...STOP, startedAt: NOW + 5 * DAY + 30_000, stoppedAt: NOW + 5 * DAY }]);

  expect(await evaluate(h)).toEqual([
    {
      kind: 'service_restarted',
      level: 'note',
      reason: 'The Service stopped once at 2026-10-11 12:00 UTC. It last stopped cleanly.',
      subject: 'web',
    },
  ]);
  expect(await evaluate(h, NOW + DAY - 1)).toHaveLength(1);
  expect(await evaluate(h, NOW + DAY)).toEqual([]);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT action FROM condition_transitions ORDER BY id`,
  ).toEqual([{ action: 'raised' }, { action: 'cleared' }]);
});

test('a stop delivered more than 24 hours after it stopped is stored but raises nothing', async () => {
  await using h = await startHub();
  await send(h, [{ ...STOP, stoppedAt: NOW - DAY - 1 }]);

  expect(await evaluate(h)).toEqual([]);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT count(*)::integer AS count FROM service_stops`,
  ).toEqual([{ count: 1 }]);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT action FROM condition_transitions`,
  ).toEqual([]);
});

test('a System with only old stops clears its open note and raises nothing', async () => {
  await using h = await startHub();
  await send(h, [STOP, { ...STOP, service: 'proxy', stoppedAt: NOW - 2 * DAY }]);
  expect(await evaluate(h)).toMatchObject([{ subject: 'web' }]);

  expect(await evaluate(h, NOW + DAY)).toEqual([]);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT action FROM condition_transitions ORDER BY id`,
  ).toEqual([{ action: 'raised' }, { action: 'cleared' }]);
});

test.each([
  { exitStatus: 0, ongoing: false, result: 'success', words: 'It last stopped cleanly.' },
  {
    exitStatus: 1,
    ongoing: false,
    result: 'exit-code',
    words: 'It last failed (exit-code, exit status 1).',
  },
  {
    exitStatus: null,
    ongoing: false,
    result: 'signal',
    words: 'It last failed (signal, exit status unknown).',
  },
  { exitStatus: null, ongoing: false, result: null, words: 'The latest result is unknown.' },
  {
    exitStatus: 1,
    ongoing: true,
    result: 'exit-code',
    words: 'It last failed (exit-code, exit status 1); it is still stopped.',
  },
])('the latest result reads honestly: $words', async ({ words, ...changes }) => {
  await using h = await startHub();
  await send(h, [{ ...STOP, ...changes, startedAt: null }]);

  expect(await evaluate(h)).toMatchObject([
    {
      reason: `The Service stopped once at 2026-10-06 11:59 UTC. ${words}`,
    },
  ]);
});

test('the count covers only the latest run, including 24-hour gaps and stops older than a day', async () => {
  await using h = await startHub();
  await send(h, [
    { ...STOP, stoppedAt: NOW - 4 * DAY },
    { ...STOP, restarts: 1, stoppedAt: NOW - 2 * DAY },
    { ...STOP, restarts: 2, stoppedAt: NOW - DAY },
    { ...STOP, exitStatus: 1, result: 'exit-code', stoppedAt: NOW },
  ]);

  expect(await evaluate(h)).toMatchObject([
    {
      reason:
        'The Service stopped 3 times, first at 2026-10-04 12:00 UTC and last at 2026-10-06 12:00 UTC. It last failed (exit-code, exit status 1), with 3 automatic restarts in total.',
    },
  ]);
});

test('an ended update changes the reason without another transition and remains a note', async () => {
  await using h = await startHub();
  await send(h, [{ ...STOP, exitStatus: null, ongoing: true, result: null, startedAt: null }]);
  expect(await evaluate(h)).toMatchObject([{ reason: expect.stringContaining('still stopped') }]);
  await send(h, [STOP], NOW + 1000);

  expect(await evaluate(h, NOW + 1000)).toMatchObject([
    { level: 'note', reason: expect.not.stringContaining('still stopped') },
  ]);
  expect(
    await h.db.sql<Record<string, unknown>[]>`SELECT action FROM condition_transitions`,
  ).toEqual([{ action: 'raised' }]);
});

test('the minute pass evaluates Service restarted after Service down', async () => {
  await using h = await startHub();
  await send(h, [STOP]);

  await evaluateConditions(h.db.sql, () => NOW, SYSTEM_CONDITION_THRESHOLDS);

  expect(
    await h.db.sql<
      Record<string, unknown>[]
    >`SELECT level FROM conditions WHERE kind = 'service_restarted'`,
  ).toEqual([{ level: 'note' }]);
});

test('a failing System does not stop the other Systems, and the error names it', async () => {
  await using h = await startHub();
  await send(h, [STOP]);
  const response = await push(
    h.hub,
    {
      ...report('server-1', [NOW]),
      checks: { services: [] },
      serviceStops: { stops: [STOP] },
    },
    { token: 'server-token' },
  );
  expect(response.status).toBe(200);
  await h.db.sql`
    ALTER TABLE conditions ADD CONSTRAINT refused_system CHECK (system <> 'laptop-1' OR kind <> 'service_restarted')
  `;

  const failure = await evaluateServiceStopConditions(h.db.sql, () => NOW).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ message: expect.stringContaining('laptop-1') });
  expect(await h.db.sql<Record<string, unknown>[]>`SELECT system, level FROM conditions`).toEqual([
    { level: 'note', system: 'server-1' },
  ]);
});
