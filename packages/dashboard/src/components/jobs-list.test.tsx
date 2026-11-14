import { describe, expect, test } from 'bun:test';

import type { JobsRow } from '../server/jobs-types.ts';
import { JobsList } from './jobs-list.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const job = (name: string, extra: Partial<JobsRow> = {}): JobsRow => ({
  at: NOW - HOUR,
  graceMinutes: 60,
  lastRunAt: NOW - HOUR,
  latestRun: { exitStatus: 0, finished: NOW - HOUR, started: NOW - HOUR - 18_000 },
  name,
  nextDue: NOW + HOUR,
  schedule: [{ hour: 3, minute: 0 }],
  scheduler: 'systemd-timer',
  state: 'ok',
  strip: [{ at: NOW - HOUR, kind: 'ok' }],
  system: 'server-1',
  wasDueAt: undefined,
  ...extra,
});

describe('the Jobs list', () => {
  test('lists jobs in the order given, each with its latest run and schedule', async () => {
    const html = await renderRouted(
      <JobsList
        jobs={[
          job('backup', {
            latestRun: { exitStatus: 1, finished: NOW - HOUR, started: NOW - HOUR - 252_000 },
            state: 'failing',
          }),
          job('rotate', { state: 'overdue', wasDueAt: NOW - 2 * HOUR }),
          job('sync'),
        ]}
        now={NOW}
      />,
    );

    expect([...html.matchAll(/<tr[^>]*data-state="(\w+)"/gu)].map(([, state]) => state)).toEqual([
      'failing',
      'overdue',
      'ok',
    ]);
    expect(html).toContain('daily 03:00 · systemd-timer');
    expect(html).toContain('Failing');
    expect(linksIn(html).find(({ label }) => label === 'backup')?.href).toBe(
      '/systems/server-1?tab=records',
    );
  });

  test('draws a missed run as its own cell, and a job with no stored history as unknown', async () => {
    const html = await renderRouted(
      <JobsList
        jobs={[
          job('backup', {
            strip: [
              { at: NOW - 3 * HOUR, kind: 'ok' },
              { at: NOW - 2 * HOUR, kind: 'missed' },
              { at: NOW - HOUR, kind: 'failed' },
            ],
          }),
          job('legacy', { strip: undefined }),
        ]}
        now={NOW}
      />,
    );

    // The table and the phone's cards each hold the strip.
    expect([...html.matchAll(/data-kind="(\w+)"/gu)].map(([, kind]) => kind)).toEqual([
      'ok',
      'missed',
      'failed',
      'ok',
      'missed',
      'failed',
    ]);
    expect(html).toContain('Last 3 runs: succeeded, missed, failed');
    expect(html).toContain('history not sent');
  });
});
