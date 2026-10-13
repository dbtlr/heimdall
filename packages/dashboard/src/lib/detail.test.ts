import { describe, expect, test } from 'bun:test';

import {
  bucketGrid,
  costPlacement,
  formatGiB,
  headerLine,
  memoryRows,
  processRows,
  sampleProcessLine,
  timelineWhen,
  unlinkedLine,
} from './detail.ts';
import { formatSpan } from './time.ts';

// Tuesday 2026-10-06 16:00 UTC.
const NOW = Date.UTC(2026, 9, 6, 16, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const at = { now: NOW, timeZone: 'UTC' };

describe('formatSpan', () => {
  test('reads in the largest two units that matter', () => {
    expect(formatSpan(20 * SECOND)).toBe('20 s');
    expect(formatSpan(4 * MINUTE)).toBe('4 min');
    expect(formatSpan(7 * HOUR + 33 * MINUTE)).toBe('7 h 33 min');
    expect(formatSpan(2 * HOUR)).toBe('2 h');
    expect(formatSpan(DAY + 2 * HOUR)).toBe('1 d 2 h');
    expect(formatSpan(6 * DAY + 20 * MINUTE)).toBe('6 d');
  });
});

describe('formatGiB', () => {
  test('gives bytes in GiB to one decimal', () => {
    expect(formatGiB(41.73 * GIB)).toBe('41.7');
  });
});

describe('headerLine', () => {
  const detail = {
    harnesses: [
      { harness: 'claude-code', version: '2.4.1' },
      { harness: 'codex', version: '0.163.0' },
    ],
    lastSeenAt: NOW - 4 * SECOND,
    latest: { t: NOW - 4 * SECOND, uptimeSeconds: 6 * 86_400 + 3600 },
    platform: { arch: 'x64', os: 'linux' },
  };

  test('names the platform, uptime, last Report, and installed Harnesses', () => {
    expect(headerLine(detail, at)).toBe(
      'Linux x64, up 6 d 1 h, last Report 4 s ago. Claude Code 2.4.1 and Codex 0.163.0.',
    );
  });

  test('calls darwin macOS and leaves out what the Hub does not hold', () => {
    expect(
      headerLine(
        {
          harnesses: [],
          lastSeenAt: NOW - 3 * DAY,
          latest: undefined,
          platform: { arch: 'arm64', os: 'darwin' },
        },
        at,
      ),
    ).toBe('macOS arm64, last Report Sat 16:00.');
    expect(
      headerLine(
        { harnesses: [], lastSeenAt: undefined, latest: undefined, platform: undefined },
        at,
      ),
    ).toBe('Never heard from.');
  });

  test('gives no uptime from a sample that is no longer current', () => {
    expect(
      headerLine(
        {
          ...detail,
          harnesses: [],
          lastSeenAt: NOW - HOUR,
          latest: { t: NOW - HOUR, uptimeSeconds: 60 },
        },
        at,
      ),
    ).toBe('Linux x64, last Report 1 h ago.');
  });
});

describe('timelineWhen', () => {
  test('says how long an open Condition has been open', () => {
    expect(timelineWhen({ clearedAt: undefined, raisedAt: NOW - 7 * HOUR }, at)).toBe(
      'Open since 09:00, 7 h',
    );
  });

  test('says when a cleared Condition was raised and cleared, and for how long', () => {
    expect(
      timelineWhen({ clearedAt: NOW - 3 * DAY + 12 * MINUTE, raisedAt: NOW - 3 * DAY }, at),
    ).toBe('Sat 16:00 to Sat 16:12, 12 min');
  });
});

describe('the inspector', () => {
  const process = {
    cores: 11.24,
    harness: 'claude-code',
    pid: 48_211,
    processId: 1,
    project: 'heimdall',
    requests: 6,
    rssBytes: 9.8 * GIB,
    sessions: [{ branch: 'hmd-78-mocks', project: 'heimdall' }],
  };

  test('describes a process, its Session, and the requests it answered', () => {
    expect(sampleProcessLine(process)).toEqual({
      detail: 'heimdall on hmd-78-mocks, linked. 6 requests answered in this sample.',
      title: 'Claude Code pid 48211, 11.2 cores, 9.8 GiB',
    });
  });

  test('says when no Session is linked to a process, and when it has no reading', () => {
    expect(
      sampleProcessLine({
        ...process,
        cores: undefined,
        requests: 0,
        rssBytes: undefined,
        sessions: [],
      }),
    ).toEqual({ detail: 'In heimdall, no Session linked.', title: 'Claude Code pid 48211' });
  });

  test('names every Session a process ran', () => {
    expect(
      sampleProcessLine({
        ...process,
        requests: 0,
        sessions: [
          { branch: 'a', project: 'heimdall' },
          { branch: 'b', project: 'heimdall' },
        ],
      }).detail,
    ).toBe('heimdall on a and heimdall on b, linked.');
  });

  test('describes a Session no single process is linked to', () => {
    const session = {
      branch: 'main',
      candidates: 2,
      harness: 'claude-code',
      link: 'ambiguous' as const,
      project: 'dotfiles',
      requests: 1,
      sessionId: 's2',
    };

    expect(unlinkedLine(session)).toEqual({
      detail:
        'dotfiles on main, ambiguous: 2 processes share its directory. 1 request answered in this sample.',
      title: 'Claude Code Session',
    });
    expect(unlinkedLine({ ...session, candidates: 0, link: 'unmatched', requests: 0 }).detail).toBe(
      'dotfiles on main, unmatched: no process ran in its directory.',
    );
    expect(unlinkedLine({ ...session, candidates: 1, link: 'unmatched', requests: 0 }).detail).toBe(
      'dotfiles on main, unmatched: one process may have run it, but the link is unconfirmed.',
    );
  });
});

describe('chart rows', () => {
  const BUCKET = 5 * MINUTE;
  const window = { from: NOW - 20 * MINUTE + 1000, to: NOW };

  test('lay one row per 5-minute bucket of the window, at its middle', () => {
    expect(bucketGrid(window)).toEqual([
      NOW - 20 * MINUTE,
      NOW - 15 * MINUTE,
      NOW - 10 * MINUTE,
      NOW - 5 * MINUTE,
    ]);
  });

  test('give memory used in GiB, and null where a bucket has none, so the line breaks', () => {
    expect(
      memoryRows([{ t: NOW - 15 * MINUTE, totalBytes: 4 * GIB, usedBytes: 2 * GIB }], window),
    ).toEqual([
      { t: NOW - 20 * MINUTE + BUCKET / 2, used: null },
      { t: NOW - 15 * MINUTE + BUCKET / 2, used: 2 },
      { t: NOW - 10 * MINUTE + BUCKET / 2, used: null },
      { t: NOW - 5 * MINUTE + BUCKET / 2, used: null },
    ]);
  });

  test('give each process its cores under its own key', () => {
    const rows = processRows(
      [
        {
          harness: 'codex',
          pid: 1,
          points: [{ cores: 0.5, t: NOW - 10 * MINUTE }],
          processId: 7,
          project: undefined,
        },
        {
          harness: 'codex',
          pid: 2,
          points: [{ cores: null, t: NOW - 5 * MINUTE }],
          processId: 8,
          project: undefined,
        },
      ],
      window,
    );

    expect(rows[2]).toEqual({ p7: 0.5, p8: null, t: NOW - 10 * MINUTE + BUCKET / 2 });
    expect(rows[3]).toEqual({ p7: null, p8: null, t: NOW - 5 * MINUTE + BUCKET / 2 });
  });
});

const stretch = (startedAt: number, endedAt: number) => ({
  endedAt,
  link: 'linked' as const,
  startedAt,
});

describe('costPlacement', () => {
  const window = { from: 0, to: 1000 };
  test('puts the cost after the last stretch', () => {
    expect(costPlacement({ stretches: [stretch(100, 200), stretch(400, 500)] }, window)).toEqual({
      left: 50,
    });
  });

  test('puts it before the first stretch when the last runs near the right edge', () => {
    expect(costPlacement({ stretches: [stretch(700, 800), stretch(850, 1000)] }, window)).toEqual({
      right: 30,
    });
  });

  test('puts it over the first stretch when the Session spans the window, leaving no room', () => {
    expect(costPlacement({ stretches: [stretch(-500, 400), stretch(600, 1000)] }, window)).toEqual({
      over: 0,
    });
  });
});
