import { expect, test } from 'bun:test';

import type { DrainResult } from './capture.ts';
import { startCapture } from './loop.ts';

const DAY_MS = 86_400_000;

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    // oxlint-disable-next-line no-await-in-loop -- polling a live loop.
    await Bun.sleep(2);
  }
};

// A capture that counts scans and drains, answering each drain with `drains`.
const fakeCapture = (drain: () => DrainResult, oldestAt: () => number | null = () => null) => {
  const counts = { drains: 0, scans: 0 };
  return {
    capture: {
      drain: () => {
        counts.drains += 1;
        return Promise.resolve(drain());
      },
      scan: () => {
        counts.scans += 1;
        return Promise.resolve();
      },
      section: () => ({ sources: [], spool: { bytes: 0, oldestAt: oldestAt() } }),
    },
    counts,
  };
};

test('scans every interval while a failing Hub is retried less and less often', async () => {
  const { capture, counts } = fakeCapture(() => ({ kind: 'failed', reason: 'Hub down' }));
  const warnings: string[] = [];
  const stop = startCapture({
    capture,
    intervalMs: 5,
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    maxBackoffMs: 1000,
    now: Date.now,
  });
  await until(() => counts.scans >= 40);
  await stop();

  expect(counts.drains).toBeLessThan(10);
  expect(warnings.filter((w) => w.includes('Hub down'))).toHaveLength(1);
});

test('says once when uploads work again', async () => {
  let down = true;
  const { capture, counts } = fakeCapture(() =>
    down ? { kind: 'failed', reason: 'Hub down' } : { kind: 'drained' },
  );
  const infos: string[] = [];
  const stop = startCapture({
    capture,
    intervalMs: 2,
    log: { info: (m) => infos.push(m), warn: () => {} },
    maxBackoffMs: 4,
    now: Date.now,
  });
  await until(() => counts.drains >= 2);
  down = false;
  const drained = counts.drains;
  await until(() => counts.drains >= drained + 3);
  await stop();

  expect(infos.filter((m) => m.includes('works again'))).toHaveLength(1);
});

test('warns once when the spool holds content from more than a day ago', async () => {
  const now = Date.UTC(2026, 9, 9);
  const { capture, counts } = fakeCapture(
    () => ({ kind: 'failed', reason: 'Hub down' }),
    () => now - DAY_MS - 1,
  );
  const warnings: string[] = [];
  const stop = startCapture({
    capture,
    intervalMs: 2,
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    maxBackoffMs: 4,
    now: () => now,
  });
  await until(() => counts.scans >= 5);
  await stop();

  expect(warnings.filter((w) => w.includes('more than a day'))).toHaveLength(1);
});

test('a scan that throws is logged and the loop carries on', async () => {
  const { capture, counts } = fakeCapture(() => ({ kind: 'drained' }));
  const failing = {
    ...capture,
    scan: () => {
      counts.scans += 1;
      return Promise.reject(new Error('disk on fire'));
    },
  };
  const warnings: string[] = [];
  const stop = startCapture({
    capture: failing,
    intervalMs: 2,
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    now: Date.now,
  });
  await until(() => counts.scans >= 3);
  await stop();

  expect(warnings[0]).toContain('disk on fire');
});

test('a drain that throws backs off like a failed one, and is reported once', async () => {
  const { capture, counts } = fakeCapture(() => {
    throw new Error('spool is locked');
  });
  const warnings: string[] = [];
  const stop = startCapture({
    capture,
    intervalMs: 5,
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    maxBackoffMs: 1000,
    now: Date.now,
  });
  await until(() => counts.scans >= 40);
  await stop();

  expect(counts.drains).toBeLessThan(10);
  expect(warnings.filter((w) => w.includes('spool is locked'))).toHaveLength(1);
});
