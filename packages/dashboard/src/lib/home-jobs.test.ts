import { describe, expect, test } from 'bun:test';

import type { HomeJob } from '../server/home-types.ts';
import { homeJob, jobWords, orderJobs } from './home-jobs.ts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const job = (name: string, over: Partial<HomeJob> = {}): HomeJob => ({
  at: NOW - HOUR,
  lastRunAt: NOW - HOUR,
  name,
  state: 'ok',
  system: 'server-1',
  ...over,
});

describe('homeJob', () => {
  const run = (exitStatus: number) => ({
    exitStatus,
    finished: NOW - HOUR,
    started: NOW - 2 * HOUR,
  });
  const base = { dueAt: NOW + HOUR, name: 'backup', overdueSince: undefined, system: 'db-1' };

  test('a failed latest run or an open Job failing is failing, from when the run finished', () => {
    expect(homeJob({ ...base, failing: false, latestRun: run(2) })).toMatchObject({
      at: NOW - HOUR,
      state: 'failing',
    });
    expect(homeJob({ ...base, failing: true, latestRun: run(0) }).state).toBe('failing');
  });

  test('an open Job overdue is overdue from when it was raised; a good run is ok; no run is due at its next time', () => {
    expect(
      homeJob({ ...base, failing: false, latestRun: run(0), overdueSince: NOW - 5 * HOUR }),
    ).toEqual({
      at: NOW - 5 * HOUR,
      lastRunAt: NOW - HOUR,
      name: 'backup',
      state: 'overdue',
      system: 'db-1',
    });
    expect(homeJob({ ...base, failing: false, latestRun: run(0) })).toMatchObject({
      at: NOW - HOUR,
      state: 'ok',
    });
    expect(homeJob({ ...base, failing: false, latestRun: undefined })).toEqual({
      at: NOW + HOUR,
      lastRunAt: undefined,
      name: 'backup',
      state: 'due',
      system: 'db-1',
    });
  });
});

test('orderJobs puts failing first, then overdue, then the most recent run, and jobs never run last', () => {
  const jobs = [
    job('never', { at: NOW + HOUR, lastRunAt: undefined, state: 'due' }),
    job('older', { lastRunAt: NOW - 3 * HOUR }),
    job('late', { state: 'overdue' }),
    job('newer', { lastRunAt: NOW - HOUR }),
    job('broken', { lastRunAt: NOW - 9 * HOUR, state: 'failing' }),
  ];

  expect(orderJobs(jobs).map(({ name }) => name)).toEqual([
    'broken',
    'late',
    'newer',
    'older',
    'never',
  ]);
});

test("each state's words carry its time", () => {
  const at = NOW - HOUR;
  expect(jobWords(job('a', { state: 'failing' }), NOW)).toEqual([
    'failed ',
    { at, format: 'when', now: NOW },
  ]);
  expect(jobWords(job('a', { state: 'overdue' }), NOW)).toEqual([
    'overdue since ',
    { at, format: 'when', now: NOW },
  ]);
  expect(jobWords(job('a'), NOW)).toEqual(['ok ', { at, format: 'when', now: NOW }]);
  expect(jobWords(job('a', { at: NOW + HOUR, state: 'due' }), NOW)).toEqual([
    'due ',
    { at: NOW + HOUR, format: 'ahead', now: NOW },
  ]);
  expect(jobWords(job('a', { at: undefined, state: 'due' }), NOW)).toEqual(['not run yet']);
});
