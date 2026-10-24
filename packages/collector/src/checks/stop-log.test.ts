import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { MAX_STOPS_PER_SERVICE, openStopLog } from './stop-log.ts';
import type { StopFacts } from './stop-log.ts';

const DAY = 86_400_000;
const T = Date.parse('2026-10-24T02:00:00Z');

// A proxy that last left its running state at `stoppedAt`, and is running
// again since `startedAt`, or still stopped when that is null.
const facts = (stoppedAt: number | null, startedAt: number | null): StopFacts => ({
  exitStatus: startedAt === null ? 1 : 0,
  restarts: 0,
  result: startedAt === null ? 'exit-code' : 'success',
  running: startedAt !== null,
  startedAt: startedAt ?? T - DAY,
  stoppedAt,
});

// A stop log in `dir` over a clock the test moves, with the proxy seen running.
const setup = async (dir: { path: string }) => {
  let now = T;
  const stops = await openStopLog({ now: () => now, stateDir: dir.path });
  const observe = (seen: StopFacts) =>
    stops.observe({ boot: 'b', checkedAt: now, facts: seen, key: 'proxy', service: 'proxy' });
  observe(facts(null, T - DAY));
  return {
    advance: (ms: number) => {
      now += ms;
    },
    observe,
    stops,
  };
};

test('a stop that ends more than 7 days after it began is still sent as ended', async () => {
  await using dir = await tempStateDir();
  const { advance, observe, stops } = await setup(dir);
  observe(facts(T, null));
  stops.pending().settle();

  advance(8 * DAY);
  observe(facts(T, T + 8 * DAY));
  const ended = stops.pending().stops;
  stops.close();

  expect(ended).toMatchObject([{ ongoing: false, startedAt: T + 8 * DAY, stoppedAt: T }]);
});

test('a stop the Hub never took is dropped 7 days after it last changed', async () => {
  await using dir = await tempStateDir();
  const { advance, observe, stops } = await setup(dir);
  observe(facts(T, T + 1000));

  advance(7 * DAY - 1);
  const kept = stops.pending().stops;
  advance(2);
  const dropped = stops.pending().stops;
  stops.close();

  expect(kept).toHaveLength(1);
  expect(dropped).toEqual([]);
});

test('keeps the newest 1,000 stops of a Service the Hub has not taken', async () => {
  await using dir = await tempStateDir();
  const { observe, stops } = await setup(dir);
  for (let i = 0; i <= MAX_STOPS_PER_SERVICE; i += 1) {
    observe(facts(T + i * 1000, T + i * 1000 + 500));
  }

  const first = stops.pending().stops;
  stops.close();

  expect(first).toHaveLength(MAX_STOPS_PER_SERVICE);
  expect(first[0]?.stoppedAt).toBe(T + 1000);
});

test('a stop that ends while a Report carries it is sent again once that Report is settled', async () => {
  await using dir = await tempStateDir();
  const { observe, stops } = await setup(dir);
  observe(facts(T, null));

  const carried = stops.pending();
  observe(facts(T, T + 5000));
  carried.settle();
  const after = stops.pending().stops;
  stops.close();

  expect(carried.stops).toMatchObject([{ ongoing: true }]);
  expect(after).toMatchObject([{ ongoing: false, startedAt: T + 5000, stoppedAt: T }]);
});

test('a stop under way is not sent again while nothing about it changes', async () => {
  await using dir = await tempStateDir();
  const { observe, stops } = await setup(dir);
  observe(facts(T, null));
  stops.pending().settle();

  observe(facts(T, null));
  const unchanged = stops.pending().stops;
  stops.close();

  expect(unchanged).toEqual([]);
});

test('a later check that sees a stopped Service end another way takes that result', async () => {
  await using dir = await tempStateDir();
  const { observe, stops } = await setup(dir);
  // Still shutting down at the first check, and timed out by the next.
  observe({ ...facts(T, null), exitStatus: 0, result: 'success' });
  stops.pending().settle();

  observe({ ...facts(T, null), exitStatus: 9, result: 'timeout' });
  const updated = stops.pending().stops;
  stops.close();

  expect(updated).toMatchObject([{ exitStatus: 9, ongoing: true, result: 'timeout' }]);
});

test('a long stop that a new boot ends is still sent as ended with no known end', async () => {
  await using dir = await tempStateDir();
  const { advance, observe, stops } = await setup(dir);
  observe(facts(T, null));
  stops.pending().settle();

  advance(8 * DAY);
  stops.observe({
    boot: 'b2',
    checkedAt: T,
    facts: facts(null, T + 8 * DAY),
    key: 'proxy',
    service: 'proxy',
  });
  const ended = stops.pending().stops;
  stops.close();

  expect(ended).toMatchObject([{ ongoing: false, startedAt: null, stoppedAt: T }]);
});

test('a later check that sees only another exit status takes it', async () => {
  await using dir = await tempStateDir();
  const { observe, stops } = await setup(dir);
  observe({ ...facts(T, null), exitStatus: 1, result: 'exit-code' });
  stops.pending().settle();

  observe({ ...facts(T, null), exitStatus: 2, result: 'exit-code' });
  const updated = stops.pending().stops;
  stops.close();

  expect(updated).toMatchObject([{ exitStatus: 2, ongoing: true }]);
});

test('a log from before stops were unique by Service and time opens with one of each', async () => {
  await using dir = await tempStateDir();
  const old = new Database(join(dir.path, 'stops.sqlite'), { create: true });
  old.run(
    'CREATE TABLE stops (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, service TEXT NOT NULL, stopped_at INTEGER NOT NULL, started_at INTEGER, ongoing INTEGER NOT NULL, restarts INTEGER NOT NULL, result TEXT, exit_status INTEGER, revision INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL)',
  );
  const insert = old.query(
    "INSERT INTO stops (key, service, stopped_at, started_at, ongoing, restarts, revision, changed_at) VALUES ('proxy', 'proxy', ?, ?, 0, 0, 1, ?)",
  );
  insert.run(T, T + 5000, T);
  insert.run(T, T + 7000, T);
  old.close();

  const stops = await openStopLog({ now: () => T, stateDir: dir.path });
  const pending = stops.pending().stops;
  stops.close();

  expect(pending).toMatchObject([{ startedAt: T + 7000, stoppedAt: T }]);
});

test('a check that sees a stop under way with no word on how it went keeps the word and sends nothing new', async () => {
  await using dir = await tempStateDir();
  const { observe, stops } = await setup(dir);
  observe(facts(T, null));
  stops.pending().settle();

  observe({ ...facts(T, null), exitStatus: null, result: null });
  const pending = stops.pending().stops;
  observe(facts(T, T + 60_000));
  const ended = stops.pending().stops;
  stops.close();

  expect(pending).toEqual([]);
  expect(ended).toMatchObject([{ exitStatus: 1, ongoing: false, result: 'exit-code' }]);
});
