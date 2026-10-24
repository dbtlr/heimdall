import { expect, test } from 'bun:test';

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
    stops.observe({ boot: 'b', facts: seen, key: 'proxy', service: 'proxy' });
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
