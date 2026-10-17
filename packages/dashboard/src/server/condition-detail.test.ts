import { beforeAll, describe, expect, test } from 'bun:test';

import {
  NOW,
  parseConditionLimits,
  push,
  report,
  startHub,
  storeConditionLimits,
  timeline,
} from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import { processSubject } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { parseConditionDetailInput, readConditionDetail } from './condition-detail.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUCKET_MS = 5 * MINUTE * 1000;

// Seconds after NOW, as the Hub's fixtures take them.
const { addCondition, addVitals } = timeline(NOW);

const at = (seconds: number) => NOW + seconds * 1000;
const bucketOf = (seconds: number) => Math.floor(at(seconds) / BUCKET_MS) * BUCKET_MS;

type Sample = ReturnType<typeof sample>;

// Sends one Report from `system` carrying `samples`, which the Hub receives at NOW.
const hear = async (h: Hub, system: string, samples: Sample[] = [sample(NOW)]) => {
  h.clock.now = NOW;
  const response = await push(
    h.hub,
    { ...report(system, []), samples },
    { token: `${system.split('-')[0]}-token` },
  );
  expect(response.status).toBe(200);
};

// A sample `seconds` after NOW with one disk.
const diskSample = (seconds: number, ...disks: { mount: string; usedBytes: number }[]): Sample => ({
  ...sample(at(seconds)),
  disks: disks.map(({ mount, usedBytes }) => ({ mount, totalBytes: 1000, usedBytes })),
});

const BOOT = 'boot-1';

// A sample `seconds` after NOW whose top processes are `top`.
const processSample = (
  seconds: number,
  top: { cpuCores: number; name?: string; pid: number; start: string }[],
  bootId = BOOT,
): Sample => ({
  ...sample(at(seconds)),
  processes: {
    bootId,
    census: { kind: 'partial' },
    intervalMs: 15_000,
    top: top.map(({ name = 'node', ...rest }) => ({ ...rest, name, rssBytes: 1 })),
  },
});

const read = (h: Hub, input: { id: string; name: string; now?: number }) =>
  readConditionDetail(h.db.sql, { now: NOW, ...input });

describe('parseConditionDetailInput', () => {
  test('takes a System name and a numeric occurrence id', () => {
    expect(parseConditionDetailInput({ id: '12', name: 'server-1' })).toEqual({
      id: '12',
      name: 'server-1',
    });
  });

  test.each(['', 'abc', '-1', '1.5', '1e3', '12 '])('rejects the id %p', (id) => {
    expect(() => parseConditionDetailInput({ id, name: 'server-1' })).toThrow();
  });

  test('rejects an id that is not text and a request that names no System', () => {
    expect(() => parseConditionDetailInput({ id: 12, name: 'server-1' })).toThrow();
    expect(() => parseConditionDetailInput({ id: '12' })).toThrow();
    expect(() => parseConditionDetailInput({ id: '12', name: '' })).toThrow();
  });
});

// A System with disk readings across 8 days, and an open low_disk Condition on
// one of its mounts.
const openDisk = async (h: Hub) => {
  await hear(h, 'server-1', [
    diskSample(-8 * DAY, { mount: '/data', usedBytes: 100 }),
    diskSample(-6 * DAY, { mount: '/data', usedBytes: 300 }),
    diskSample(-HOUR, { mount: '/data', usedBytes: 600 }, { mount: '/other', usedBytes: 999 }),
    diskSample(0, { mount: '/data', usedBytes: 700 }),
  ]);
  return addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'alert',
    raisedAt: -3 * DAY,
    reason: 'raised',
    subject: '/data',
    system: 'server-1',
    transitions: [{ at: -DAY, level: 'warning', reason: 'eased' }],
  });
};

describe('an open Condition', () => {
  test('carries its transitions, its attention item, and the disk readings of the last 7 days', async () => {
    await using h = await startHub();
    const id = await openDisk(h);

    const detail = await read(h, { id, name: 'server-1' });

    expect(detail).toMatchObject({
      clearedAt: undefined,
      from: at(-7 * DAY),
      id,
      kind: 'low_disk',
      level: 'warning',
      raisedAt: at(-3 * DAY),
      subject: '/data',
      system: 'server-1',
      to: NOW,
    });
    expect(detail?.transitions.map(({ kind }) => kind)).toEqual(['raised', 'level_changed']);
    expect(detail?.attention).toMatchObject({ conditionId: id, kind: 'low_disk' });
    expect(detail?.series).toEqual({
      kind: 'disk',
      points: [
        { t: bucketOf(-6 * DAY), totalBytes: 1000, usedBytes: 300 },
        { t: bucketOf(-HOUR), totalBytes: 1000, usedBytes: 600 },
        { t: bucketOf(0), totalBytes: 1000, usedBytes: 700 },
      ],
    });
  });

  test('finds its attention item when the id is written with leading zeros', async () => {
    await using h = await startHub();
    const id = await openDisk(h);

    const detail = await read(h, { id: `00${id}`, name: 'server-1' });

    expect(detail?.id).toBe(id);
    expect(detail?.attention).toMatchObject({ conditionId: id, kind: 'low_disk' });
  });

  test('leaves out a bucket that starts before the window', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', [
      diskSample(-7 * DAY + 10, { mount: '/data', usedBytes: 100 }),
      diskSample(-HOUR, { mount: '/data', usedBytes: 600 }),
    ]);
    const id = await addCondition(h.db.sql, {
      kind: 'low_disk',
      raisedAt: -3 * DAY,
      subject: '/data',
      system: 'server-1',
    });

    // A minute later than the fixtures' clock, so the window starts inside a bucket.
    const detail = await read(h, { id, name: 'server-1', now: NOW + 60_000 });

    expect(detail?.series).toEqual({
      kind: 'disk',
      points: [{ t: bucketOf(-HOUR), totalBytes: 1000, usedBytes: 600 }],
    });
  });

  test('shows the limits stored for its System, else the fleet limits, else none', async () => {
    await using h = await startHub();
    const id = await openDisk(h);
    await hear(h, 'laptop-1');
    const laptop = await addCondition(h.db.sql, {
      kind: 'reboot_required',
      raisedAt: -HOUR,
      system: 'laptop-1',
    });

    expect((await read(h, { id, name: 'server-1' }))?.limits).toBeUndefined();

    await storeConditionLimits(
      h.db.sql,
      parseConditionLimits({
        disk: { alert: 92 },
        systems: { 'server-1': { disk: { alert: 97 } } },
      }),
    );

    expect((await read(h, { id, name: 'server-1' }))?.limits?.disk.alert).toBe(97);
    expect((await read(h, { id: laptop, name: 'laptop-1' }))?.limits?.disk.alert).toBe(92);
  });
});

describe('a cleared Condition', () => {
  test('has no attention item and its window ends when it cleared', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', [
      diskSample(-2 * HOUR, { mount: '/data', usedBytes: 500 }),
      diskSample(-30 * MINUTE, { mount: '/data', usedBytes: 200 }),
    ]);
    const id = await addCondition(h.db.sql, {
      clearedAt: -HOUR,
      kind: 'low_disk',
      raisedAt: -3 * HOUR,
      subject: '/data',
      system: 'server-1',
    });

    const detail = await read(h, { id, name: 'server-1' });

    expect(detail).toMatchObject({
      attention: undefined,
      clearedAt: at(-HOUR),
      from: at(-HOUR - 7 * DAY),
      to: at(-HOUR),
    });
    expect(detail?.transitions.map(({ kind }) => kind)).toEqual(['raised', 'cleared']);
    expect(detail?.series).toEqual({
      kind: 'disk',
      points: [{ t: bucketOf(-2 * HOUR), totalBytes: 1000, usedBytes: 500 }],
    });
  });
  test('leaves out the bucket it cleared in, which can hold readings from after it cleared', async () => {
    await using h = await startHub();
    // Seconds from NOW: two minutes into a bucket an hour or so back.
    const cleared = (bucketOf(-HOUR) - NOW) / 1000 + 2 * MINUTE;
    await hear(h, 'server-1', [
      diskSample(-2 * HOUR, { mount: '/data', usedBytes: 500 }),
      diskSample(cleared + MINUTE, { mount: '/data', usedBytes: 900 }),
    ]);
    const id = await addCondition(h.db.sql, {
      clearedAt: cleared,
      kind: 'low_disk',
      raisedAt: -3 * HOUR,
      subject: '/data',
      system: 'server-1',
    });

    const detail = await read(h, { id, name: 'server-1' });

    expect(detail?.series).toEqual({
      kind: 'disk',
      points: [{ t: bucketOf(-2 * HOUR), totalBytes: 1000, usedBytes: 500 }],
    });
  });
});

describe('an occurrence that is not there', () => {
  test('is undefined for an unknown id and for another System`s id', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    const id = await addCondition(h.db.sql, {
      kind: 'reboot_required',
      raisedAt: -HOUR,
      system: 'laptop-1',
    });

    expect(await read(h, { id, name: 'server-1' })).toBeUndefined();
    expect(await read(h, { id: '99999', name: 'laptop-1' })).toBeUndefined();
    expect(await read(h, { id, name: 'laptop-1' })).toBeDefined();
  });
});

describe('a hot process', () => {
  test('charts only the lifetime its subject names, as the busiest reading per bucket', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', [
      processSample(-2 * HOUR, [
        { cpuCores: 2, pid: 100, start: '1000' },
        { cpuCores: 8, pid: 200, start: '1000' },
      ]),
      processSample(-2 * HOUR + 15, [{ cpuCores: 3, pid: 100, start: '1000' }]),
      processSample(-HOUR, [{ cpuCores: 9, pid: 100, start: '2000' }]),
      processSample(-30 * MINUTE, [{ cpuCores: 4, pid: 100, start: '1000' }]),
      processSample(-25 * MINUTE, [{ cpuCores: 5, name: 'other', pid: 100, start: '1000' }]),
      processSample(-20 * MINUTE, []),
    ]);
    // After a reboot the same PID, start, and name are another process.
    await hear(h, 'server-1', [
      processSample(-2 * HOUR + 30, [{ cpuCores: 7, pid: 100, start: '1000' }], 'boot-2'),
    ]);
    const id = await addCondition(h.db.sql, {
      kind: 'hot_process',
      level: 'warning',
      raisedAt: -HOUR,
      subject: processSubject({ bootId: BOOT, name: 'node', pid: 100, start: '1000' }),
      system: 'server-1',
    });

    const detail = await read(h, { id, name: 'server-1' });

    expect(detail?.from).toBe(NOW - DAY * 1000);
    expect(detail?.series).toEqual({
      kind: 'cores',
      points: [
        { cores: 3, t: bucketOf(-2 * HOUR) },
        { cores: 4, t: bucketOf(-30 * MINUTE) },
      ],
    });
  });
});

describe('System load', () => {
  test('charts busy CPU as the average percent per bucket over the last 24 hours', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', [sample(at(-2 * DAY))]);
    await addVitals(h.db.sql, 'server-1', -10 * MINUTE, 40);
    await addVitals(h.db.sql, 'server-1', -10 * MINUTE + 30, 60);
    await addVitals(h.db.sql, 'server-1', -5 * MINUTE, 20);
    const id = await addCondition(h.db.sql, {
      kind: 'high_cpu',
      raisedAt: -HOUR,
      system: 'server-1',
    });

    const detail = await read(h, { id, name: 'server-1' });

    expect(detail?.series).toEqual({
      kind: 'percent',
      points: [
        { percent: 50, t: bucketOf(-10 * MINUTE) },
        { percent: 20, t: bucketOf(-5 * MINUTE) },
      ],
    });
  });

  test('charts memory as used over total, in percent', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', [sample(at(-2 * DAY))]);
    await addVitals(h.db.sql, 'server-1', -10 * MINUTE);
    const id = await addCondition(h.db.sql, {
      kind: 'high_memory',
      raisedAt: -HOUR,
      system: 'server-1',
    });

    const detail = await read(h, { id, name: 'server-1' });

    expect(detail?.series).toEqual({
      kind: 'percent',
      points: [{ percent: 50, t: bucketOf(-10 * MINUTE) }],
    });
  });
});

describe('a kind with nothing to chart', () => {
  test('has no series but keeps its 24-hour window', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    const id = await addCondition(h.db.sql, {
      kind: 'reboot_required',
      raisedAt: -HOUR,
      system: 'server-1',
    });

    const detail = await read(h, { id, name: 'server-1' });

    expect(detail?.series).toBeUndefined();
    expect(detail).toMatchObject({ from: NOW - DAY * 1000, to: NOW });
    expect(detail?.attention).toMatchObject({ conditionId: id, kind: 'reboot_required' });
  });
});
