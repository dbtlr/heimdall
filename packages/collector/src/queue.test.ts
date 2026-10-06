import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { sample } from '@heimdall/schema/testing';

import { openQueue } from './queue.ts';
import { tempStateDir } from './testing/fixtures.ts';

test('hands back samples oldest first, at most the limit', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  queue.append(sample(3000));
  queue.append(sample(1000));
  queue.append(sample(2000));

  expect(queue.oldest(2)).toEqual([sample(1000), sample(2000)]);
  queue.close();
});

test('removes delivered samples through a time', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  for (const t of [1000, 2000, 3000]) {
    queue.append(sample(t));
  }

  queue.removeThrough(2000);

  expect(queue.oldest(10)).toEqual([sample(3000)]);
  queue.close();
});

test('keeps one sample per time', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  queue.append(sample(1000));
  queue.append({ ...sample(1000), uptimeSeconds: 1 });

  expect(queue.oldest(10)).toEqual([sample(1000)]);
  queue.close();
});

test('drops the oldest samples beyond its capacity', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 2, stateDir: dir.path });
  for (const t of [1000, 2000, 3000]) {
    queue.append(sample(t));
  }

  expect(queue.oldest(10)).toEqual([sample(2000), sample(3000)]);
  queue.close();
});

test('survives the Collector restarting', async () => {
  await using dir = await tempStateDir();
  const first = await openQueue({ capacity: 10, stateDir: dir.path });
  first.append(sample(1000));
  first.close();

  const second = await openQueue({ capacity: 10, stateDir: dir.path });

  expect(second.oldest(10)).toEqual([sample(1000)]);
  second.close();
});

test('creates its state directory', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: join(dir.path, 'nested', 'heimdall') });
  queue.append(sample(1000));

  expect(queue.oldest(10)).toHaveLength(1);
  queue.close();
});

test('discards a stored sample this build cannot read', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  queue.append({ ...sample(1000), disks: [] });
  queue.append(sample(2000));

  expect(queue.oldest(10)).toEqual([sample(2000)]);
  expect(queue.oldest(10)).toEqual([sample(2000)]);
  queue.close();
});

test('keeps the newest arrivals when full, even after the clock steps back', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 2, stateDir: dir.path });
  queue.append(sample(5000));
  queue.append(sample(6000));
  queue.append(sample(1000));

  expect(queue.oldest(10)).toEqual([sample(1000), sample(6000)]);
  queue.close();
});

test('discards a stored row that is not JSON', async () => {
  await using dir = await tempStateDir();
  const queue = await openQueue({ capacity: 10, stateDir: dir.path });
  queue.append(sample(2000));
  using raw = new Database(join(dir.path, 'queue.sqlite'));
  raw.run("UPDATE samples SET sample = '{truncated' WHERE t = 2000");
  queue.append(sample(3000));

  expect(queue.oldest(10)).toEqual([sample(3000)]);
  queue.close();
});
