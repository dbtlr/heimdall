import { expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';

import { every } from './every.ts';

test('every runs the task at once, then again after each interval', async () => {
  let runs = 0;
  const stop = every({ intervalMs: 20, onError: () => {}, task: () => void (runs += 1) });

  expect(runs).toBe(1);
  await wait(110);
  await stop();

  expect(runs).toBeGreaterThanOrEqual(3);
});

test('every stops running the task once stopped', async () => {
  let runs = 0;
  const stop = every({ intervalMs: 10, onError: () => {}, task: () => void (runs += 1) });
  await wait(35);
  await stop();
  const stoppedAt = runs;

  await wait(50);

  expect(runs).toBe(stoppedAt);
});

test('every keeps running after a task fails and reports each failure', async () => {
  const failures: unknown[] = [];
  let runs = 0;
  const stop = every({
    intervalMs: 10,
    onError: (error) => failures.push(error),
    task: () => {
      runs += 1;
      if (runs === 1) {
        throw new Error('first run fails');
      }
      return Promise.reject(new Error('later run fails'));
    },
  });
  await wait(60);
  await stop();

  expect(runs).toBeGreaterThan(2);
  expect(failures).toHaveLength(runs);
  expect((failures[0] as Error).message).toBe('first run fails');
});

test('stopping waits for a task still running', async () => {
  let finished = false;
  const stop = every({
    intervalMs: 1000,
    onError: () => {},
    task: async () => {
      await wait(30);
      finished = true;
    },
  });

  await stop();

  expect(finished).toBe(true);
});

test('every can wait one interval before its first run', async () => {
  let runs = 0;
  const stop = every({
    intervalMs: 30,
    onError: () => {},
    runNow: false,
    task: () => void (runs += 1),
  });

  expect(runs).toBe(0);
  await wait(50);
  await stop();

  expect(runs).toBe(1);
});
