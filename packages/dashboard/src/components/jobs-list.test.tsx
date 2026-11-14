import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import { useTimeZone as realUseTimeZone } from '../lib/use-time-zone.ts';
import type { JobsRow } from '../server/jobs-types.ts';
import { JobsList } from './jobs-list.tsx';
import { RECORD_DOT } from './recorded-panel.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

// The server renders no zone-bound text, so the suffix tests give the viewer a
// zone, and the real hook comes back for the other test files.
const VIEWER_ZONE = 'UTC';
beforeAll(async () => {
  await mock.module('../lib/use-time-zone.ts', () => ({ useTimeZone: () => VIEWER_ZONE }));
});
afterAll(async () => {
  await mock.module('../lib/use-time-zone.ts', () => ({ useTimeZone: realUseTimeZone }));
});

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
  timeZone: 'UTC',
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
    expect(html).toContain('Daily at 03:00 · systemd-timer');
    expect(html).toContain('Failing');
    expect(linksIn(html).find(({ label }) => label === 'backup')?.href).toBe(
      '/systems/server-1?tab=records',
    );
  });

  test('draws a missed run as its own cell, and a System with no run history as unknown', async () => {
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
    expect(html).toContain('no run history');
    expect(html).not.toContain('history not sent');
  });

  test('marks a job that never ran as unknown, not OK', async () => {
    const html = await renderRouted(
      <JobsList
        jobs={[
          job('prune', {
            at: undefined,
            lastRunAt: undefined,
            latestRun: undefined,
            state: 'due',
            strip: [],
          }),
        ]}
        now={NOW}
      />,
    );

    expect([...html.matchAll(/data-level="(\w+)"/gu)].map(([, level]) => level)).toEqual([
      'unknown',
      'unknown',
    ]);
    // Hollow: a ring in the muted colour and no fill, on the dot itself.
    const dots = [...html.matchAll(/<span[^>]*data-level="unknown"[^>]*>/gu)].map(([tag]) => tag);
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot).toContain(RECORD_DOT.unknown);
      expect(dot).toContain('border-muted-foreground');
      expect(dot).not.toMatch(/\bbg-/u);
    }
    expect(html).toContain('Not run yet');
    expect(html).not.toContain('>OK<');
    expect(html).toContain('no runs yet');
  });

  test("shows a job's schedule zone when its System's differs from the viewer's, and none when it matches", async () => {
    const html = await renderRouted(
      <JobsList
        jobs={[
          job('backup', { timeZone: 'Europe/Copenhagen' }),
          job('sync', { timeZone: VIEWER_ZONE }),
        ]}
        now={NOW}
      />,
    );

    expect(html).toContain('Europe/Copenhagen');
    expect(html).not.toContain(` ${VIEWER_ZONE}`);
  });
});
