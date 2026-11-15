import { expect, test } from 'bun:test';

import { loadSystem } from './system-load.ts';

const EDGES = [1, 2, 3];

// Readers that log when each starts and finishes, the page slower than the inspector.
const readers = () => {
  const log: string[] = [];
  return {
    inspect: async (edges: readonly number[] | undefined) => {
      log.push(`inspect start ${String(edges?.length)}`);
      await Promise.resolve();
      log.push('inspect end');
      return edges;
    },
    log,
    page: async () => {
      log.push('page start');
      await Bun.sleep(5);
      log.push('page end');
      return { detail: { edges: EDGES } };
    },
  };
};

test('over a long range the bucket is read after the page, with the page edges', async () => {
  const { inspect, log, page } = readers();

  const loaded = await loadSystem({ inspect, page, range: '30d' });

  expect(log).toEqual(['page start', 'page end', 'inspect start 3', 'inspect end']);
  expect(loaded.inspected).toBe(EDGES);
});

test('up to 7 d the sample is read alongside the page, with no edges', async () => {
  const { inspect, log, page } = readers();

  const loaded = await loadSystem({ inspect, page, range: '24h' });

  expect(log.slice(0, 2)).toEqual(['page start', 'inspect start undefined']);
  expect(loaded.inspected).toBeUndefined();
});
