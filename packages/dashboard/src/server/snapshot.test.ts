import { beforeAll, expect, test } from 'bun:test';

import { startHub } from '@heimdall/hub/testing';
import { SQL } from 'bun';

import { readSnapshot, settleAll, settleBoth } from './snapshot.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

// Runs `reads` borrowing reads at once, each holding its snapshot until all
// have begun, and returns whether each read got a second connection.
const borrowAtOnce = async (url: URL, max: number, reads: number) => {
  await using pool = new SQL(url, { max });
  let arrived = 0;
  const { promise: allBegun, resolve } = Promise.withResolvers<void>();
  const read = () =>
    readSnapshot(pool, true, async (tx, side) => {
      arrived += 1;
      if (arrived === reads) {
        resolve();
      }
      await allBegun;
      const [first, second]: [{ pid: number }[], { pid: number }[]] = await settleBoth(
        tx`SELECT pg_backend_pid() AS pid`,
        side`SELECT pg_backend_pid() AS pid`,
      );
      return first[0]?.pid !== second[0]?.pid;
    });
  // Awaited here, so the pool stays open until every read settles.
  return await Promise.all(Array.from({ length: reads }, read));
};

test('concurrent reads each borrow a second connection while the pool holds a pair for each and one more', async () => {
  await using h = await startHub();
  expect(await borrowAtOnce(h.db.url, 5, 2)).toEqual([true, true]);
});

test('a read beyond the pairs the pool holds reads on one connection', async () => {
  await using h = await startHub();
  expect((await borrowAtOnce(h.db.url, 3, 2)).toSorted((a, b) => Number(a) - Number(b))).toEqual([
    false,
    true,
  ]);
  // A pool of two keeps its second connection for other reads.
  expect(await borrowAtOnce(h.db.url, 2, 1)).toEqual([false]);
  expect(await borrowAtOnce(h.db.url, 1, 1)).toEqual([false]);
});

test('a pool lends again once each borrowing read ends, however it ends', async () => {
  await using h = await startHub();
  // A pool of three lends to one read at a time.
  await using pool = new SQL(h.db.url, { max: 3 });
  const borrows = () =>
    readSnapshot(pool, true, async (tx, side) => {
      const [first, second]: [{ pid: number }[], { pid: number }[]] = await settleBoth(
        tx`SELECT pg_backend_pid() AS pid`,
        side`SELECT pg_backend_pid() AS pid`,
      );
      return first[0]?.pid !== second[0]?.pid;
    });
  expect(await borrows()).toBe(true);
  let failure: unknown;
  try {
    await readSnapshot(pool, true, () => Promise.reject(new Error('the read failed')));
  } catch (error) {
    failure = error;
  }
  expect(failure).toEqual(new Error('the read failed'));
  expect(await borrows()).toBe(true);
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
