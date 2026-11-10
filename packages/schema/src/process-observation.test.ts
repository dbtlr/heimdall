import { expect, test } from 'bun:test';

import {
  MAX_TOP_MEMORY_PROCESSES,
  ProcessObservationSchema,
  parseProcessSubject,
  processSubject,
} from './process-observation.ts';
import type { ProcessObservation } from './process-observation.ts';

test('process subjects preserve separators and keep boot, pid, start and executable distinct', () => {
  const identity = { bootId: 'boot:one', name: 'a:b["c"]', pid: 42, start: '1234' };
  expect(parseProcessSubject(processSubject(identity))).toEqual(identity);
  expect(processSubject(identity)).not.toBe(processSubject({ ...identity, name: 'a:b' }));
  expect(processSubject(identity)).not.toBe(processSubject({ ...identity, start: '1235' }));
  for (const malformed of [
    'oops',
    '{}',
    '["b",-1,"3","bun"]',
    '["b",1,"bad","bun"]',
    '["b",1,"3","bun",0]',
  ]) {
    expect(parseProcessSubject(malformed)).toBeUndefined();
  }
});

const observation = {
  bootId: 'boot-a',
  census: { kind: 'complete', presentPids: [42, 43], remainderMaxCores: 0, unknownPids: [] },
  intervalMs: 15_000,
  top: [{ cpuCores: 1.5, name: 'bun', pid: 42, rssBytes: 1024, start: '1234' }],
} satisfies ProcessObservation;

const holder = (pid: number, rssBytes: number) => ({
  name: `worker-${pid}`,
  pid,
  rssBytes,
  start: String(1000 + pid),
});

test('an observation without processes by memory stays valid, as older Collectors send it', () => {
  const parsed = ProcessObservationSchema.parse(observation);
  expect(parsed).toEqual(observation);
  expect('topByMemory' in parsed).toBe(false);
});

test('processes by memory carry name, pid, start, and resident bytes with any census', () => {
  const topByMemory = [holder(43, 4096), holder(42, 1024)];
  for (const census of [observation.census, { kind: 'partial' as const }]) {
    const withMemory = { ...observation, census, topByMemory };
    expect(ProcessObservationSchema.parse(withMemory)).toEqual(withMemory);
  }
  const unbaselined = { ...observation, intervalMs: 0, top: [], topByMemory };
  expect(ProcessObservationSchema.parse(unbaselined)).toEqual(unbaselined);
  expect(ProcessObservationSchema.parse({ ...observation, topByMemory: [] }).topByMemory).toEqual(
    [],
  );
});

test('a malformed list by memory is dropped alone, keeping the CPU evidence and census', () => {
  const tooMany = Array.from({ length: MAX_TOP_MEMORY_PROCESSES + 1 }, (_, i) =>
    holder(100 + i, 1024),
  );
  const five = tooMany.slice(0, -1);
  expect(ProcessObservationSchema.parse({ ...observation, topByMemory: five }).topByMemory).toEqual(
    five,
  );
  for (const topByMemory of [
    tooMany,
    [holder(43, 4096), { ...holder(43, 1024), start: '9999' }],
    [{ ...holder(43, 4096), name: '' }],
    [{ ...holder(43, 4096), name: 'x'.repeat(1025) }],
    [{ ...holder(43, 4096), pid: 0 }],
    [{ ...holder(43, 4096), start: 'later' }],
    [{ ...holder(43, 4096), rssBytes: 1.5 }],
    [{ ...holder(43, 4096), rssBytes: -1 }],
  ]) {
    const parsed = ProcessObservationSchema.parse({ ...observation, topByMemory });
    expect(parsed.topByMemory).toBeUndefined();
    expect(parsed).toEqual(observation);
  }
});

test('processes by memory never carry arguments or environment', () => {
  const parsed = ProcessObservationSchema.parse({
    ...observation,
    topByMemory: [{ ...holder(43, 4096), args: ['--token', 'secret'], env: { TOKEN: 'secret' } }],
  });
  expect(parsed.topByMemory).toEqual([holder(43, 4096)]);
});
