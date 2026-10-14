import { describe, expect, test } from 'bun:test';

import { phraseText, zoneFreeText } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import {
  applicationLine,
  filesLine,
  jobLine,
  provenanceLine,
  scheduleWords,
  serviceLine,
} from './recorded.ts';

// Tuesday 2026-10-06 16:00 UTC.
const NOW = Date.UTC(2026, 9, 6, 16, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const utc = (text: Phrase) => phraseText(text, 'UTC');

// Each line as written in UTC.
const service = (record: Parameters<typeof serviceLine>[0]) => {
  const line = serviceLine(record, NOW);
  return { ...line, text: utc(line.text) };
};
const job = (record: Parameters<typeof jobLine>[0]) => {
  const line = jobLine(record, NOW);
  return { ...line, text: utc(line.text) };
};
const files = (record: Parameters<typeof filesLine>[0]) => {
  const line = filesLine(record, NOW);
  return { ...line, issues: line.issues.map(({ path, text }) => ({ path, text: utc(text) })) };
};

const supervisor = (state: string, detail = 'ActiveState=active', since = NOW - 6 * HOUR) => ({
  check: 'supervisor',
  detail,
  since,
  state,
});

describe('serviceLine', () => {
  test('says since when a Service is up, and under which supervisor', () => {
    expect(service({ checks: [supervisor('up')], name: 'web', supervisor: 'systemd' })).toEqual({
      state: 'good',
      text: 'Up since 10:00 (systemd).',
    });
    expect(
      service({
        checks: [supervisor('up', 'running', NOW - 2 * DAY)],
        name: 'db',
        supervisor: 'docker',
      }).text,
    ).toBe('Up since Sun 16:00 (Docker).');
  });

  test('adds whether its health URL answers', () => {
    const up = { check: 'health', detail: 'HTTP 200', since: NOW - HOUR, state: 'up' };
    const failing = { check: 'health', detail: 'HTTP 503', since: NOW - HOUR, state: 'unhealthy' };

    expect(
      service({ checks: [supervisor('up'), up], name: 'web', supervisor: 'systemd-user' }).text,
    ).toBe('Up since 10:00 (systemd user). Health URL answers.');
    expect(
      service({ checks: [supervisor('up'), failing], name: 'web', supervisor: 'systemd' }),
    ).toEqual({
      state: 'bad',
      text: 'Up since 10:00 (systemd). Health check failing since 15:00: HTTP 503.',
    });
  });

  test('says since when a Service stopped, with what its supervisor said', () => {
    expect(
      service({
        checks: [supervisor('stopped', 'ActiveState=failed', NOW - 10 * MINUTE)],
        name: 'web',
        supervisor: 'systemd',
      }),
    ).toEqual({ state: 'bad', text: 'Stopped since 15:50 (systemd): ActiveState=failed.' });
  });

  test('is unknown when the Collector could not tell or has not checked', () => {
    expect(service({ checks: [], name: 'web', supervisor: 'systemd' })).toEqual({
      state: 'unknown',
      text: 'Not checked yet.',
    });
    expect(
      service({
        checks: [supervisor('unknown', 'launchctl exited 112')],
        name: 'web',
        supervisor: 'launchd',
      }),
    ).toEqual({ state: 'unknown', text: 'Unknown since 10:00 (launchd): launchctl exited 112.' });
  });
});

describe('a record line needs the zone only for its times', () => {
  test('a stopped Service is bad, with no zone given', () => {
    const line = serviceLine(
      {
        checks: [supervisor('stopped', 'ActiveState=failed', NOW - 10 * MINUTE)],
        name: 'web',
        supervisor: 'systemd',
      },
      NOW,
    );
    expect(line.state).toBe('bad');
    expect(zoneFreeText(line.text)).toBeUndefined();
  });

  test('a failing job is bad, and a drifted file a warning, with no zone given', () => {
    expect(
      jobLine(
        {
          latestRun: run(2, NOW - HOUR, 60),
          name: 'backup',
          open: ['job_failing'],
          schedule: [{ minute: 0 }],
        },
        NOW,
      ).state,
    ).toBe('bad');
    expect(
      filesLine(
        {
          checked: true,
          count: 2,
          issues: [{ path: '/etc/a', since: NOW - HOUR, state: 'drifted' }],
          name: 'dotfiles',
        },
        NOW,
      ).state,
    ).toBe('warning');
  });

  test('text without a time is whole without a zone', () => {
    const line = serviceLine({ checks: [], name: 'web', supervisor: 'systemd' }, NOW);
    expect(zoneFreeText(line.text)).toBe('Not checked yet.');
  });
});

describe('scheduleWords', () => {
  test('names the common schedules', () => {
    expect(scheduleWords([{ minute: 0 }])).toBe('Hourly');
    expect(scheduleWords([{ minute: 15 }])).toBe('Hourly at :15');
    expect(scheduleWords([{ hour: 1, minute: 30 }])).toBe('Daily at 01:30');
    expect(scheduleWords([{ hour: 9, minute: 0, weekday: 1 }])).toBe('Mondays at 09:00');
    expect(scheduleWords([{ day: 1, hour: 4, minute: 0 }])).toBe('Monthly on day 1 at 04:00');
  });

  test('counts the times of any other schedule', () => {
    expect(scheduleWords([{ hour: 1 }, { hour: 13 }])).toBe('2 scheduled times');
    expect(scheduleWords([{ month: 3 }])).toBe('1 scheduled time');
    expect(scheduleWords([])).toBe('No schedule');
  });
});

const run = (exitStatus: number, started: number, seconds: number) => ({
  exitStatus,
  finished: started + seconds * 1000,
  started,
});

describe('jobLine', () => {
  test('gives the schedule and how the latest run went', () => {
    expect(
      job({ latestRun: run(0, NOW - HOUR, 3), name: 'pull', open: [], schedule: [{ minute: 0 }] }),
    ).toEqual({ state: 'good', text: 'Hourly. Last run 15:00, succeeded in 3 s.' });
    expect(
      job({
        latestRun: run(2, NOW - 14.5 * HOUR, 660),
        name: 'backup',
        open: ['job_failing'],
        schedule: [{ hour: 1, minute: 30 }],
      }),
    ).toEqual({
      state: 'bad',
      text: 'Daily at 01:30. Last run 01:30, failed with exit status 2 after 11 min.',
    });
  });

  test('warns of a job that is overdue, and knows nothing of one never run', () => {
    expect(
      job({
        latestRun: run(0, NOW - 3 * HOUR, 3),
        name: 'pull',
        open: ['job_overdue'],
        schedule: [{ minute: 0 }],
      }),
    ).toEqual({ state: 'warning', text: 'Hourly. Last run 13:00, succeeded in 3 s. Overdue.' });
    expect(
      job({ latestRun: undefined, name: 'pull', open: [], schedule: [{ minute: 0 }] }),
    ).toEqual({ state: 'unknown', text: 'Hourly. No run recorded yet.' });
  });
});

describe('filesLine', () => {
  test('says how many files match when all do', () => {
    expect(files({ checked: true, count: 6, issues: [], name: 'units' })).toEqual({
      issues: [],
      rest: '6 files match.',
      state: 'good',
    });
    expect(files({ checked: true, count: 1, issues: [], name: 'units' }).rest).toBe(
      '1 file matches.',
    );
  });

  test('names each file that does not match, since when, and how many others match', () => {
    expect(
      files({
        checked: true,
        count: 38,
        issues: [{ path: '/home/someone/.gitconfig', since: NOW - 7 * HOUR, state: 'drifted' }],
        name: 'dotfiles',
      }),
    ).toEqual({
      issues: [{ path: '/home/someone/.gitconfig', text: 'drifted since 09:00' }],
      rest: '37 other files match.',
      state: 'warning',
    });
  });

  test('is unknown, with nothing listed, while the Collector has not checked this version of the record', () => {
    expect(
      files({
        checked: false,
        count: 3,
        issues: [{ path: '/etc/a', since: NOW - HOUR, state: 'drifted' }],
        name: 'dotfiles',
      }),
    ).toEqual({ issues: [], rest: 'Not checked yet.', state: 'unknown' });
  });

  test('is unknown when a file only cannot be read', () => {
    expect(
      files({
        checked: true,
        count: 1,
        issues: [{ path: '/etc/app.xml', since: NOW - 2 * DAY, state: 'unreadable' }],
        name: 'app',
      }),
    ).toEqual({
      issues: [{ path: '/etc/app.xml', text: 'cannot be read since Sun 16:00' }],
      rest: '',
      state: 'unknown',
    });
  });
});

const app = (by: string, revision?: string) => ({
  name: 'a',
  provenance: { by, revision },
  source: undefined,
  version: '1',
});

describe('applications', () => {
  test('gives the version and where it came from', () => {
    expect(
      applicationLine({ name: 'nvim', provenance: undefined, source: 'mise', version: '0.12.1' }),
    ).toBe('0.12.1, mise');
    expect(
      applicationLine({
        name: 'nvim',
        provenance: undefined,
        source: undefined,
        version: '0.12.1',
      }),
    ).toBe('0.12.1');
  });

  test('says who recorded them, once for each provisioner and revision', () => {
    expect(provenanceLine([app('fleet', 'a1b2c3d'), app('fleet', 'a1b2c3d')])).toBe(
      'Recorded by fleet at a1b2c3d.',
    );
    expect(provenanceLine([app('fleet', 'a1b2c3d'), app('ansible')])).toBe(
      'Recorded by fleet at a1b2c3d and ansible.',
    );
    expect(
      provenanceLine([{ name: 'a', provenance: undefined, source: undefined, version: '1' }]),
    ).toBeUndefined();
  });
});
