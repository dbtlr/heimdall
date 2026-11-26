import { beforeAll, expect, test } from 'bun:test';

import { startHub } from '@heimdall/hub/testing';

import { readSnapshot, settleAll } from './snapshot.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

test('a snapshot reads in one repeatable-read transaction with JIT off, and a failed read propagates', async () => {
  await using h = await startHub();
  const [setting] = await readSnapshot(h.db.sql, async (tx) => {
    const [probe]: { isolation: string; jit: string }[] = await tx`
      SELECT current_setting('transaction_isolation') AS isolation, current_setting('jit') AS jit
    `;
    return [probe];
  });
  expect(setting).toEqual({ isolation: 'repeatable read', jit: 'off' });

  let failure: unknown;
  try {
    await readSnapshot(h.db.sql, () => Promise.reject(new Error('the read failed')));
  } catch (error) {
    failure = error;
  }
  expect(failure).toEqual(new Error('the read failed'));
});

test("a snapshot's reads all settle before the first one's error ends it", async () => {
  const { promise: slow, resolve } = Promise.withResolvers<string>();
  let slowSettled = false;
  const slowRead = async () => {
    const value = await slow;
    slowSettled = true;
    return value;
  };
  const reads = settleAll([Promise.reject(new Error('the first read failed')), slowRead()]);
  setTimeout(() => resolve('done'), 20);

  let failure: unknown;
  try {
    await reads;
  } catch (error) {
    failure = error;
  }
  expect(failure).toEqual(new Error('the first read failed'));
  expect(slowSettled).toBe(true);
});
