import { describe, expect, test } from 'bun:test';

import {
  bucketGrid,
  costPlacement,
  formatGiB,
  headerLine,
  loadRows,
  memoryHoldersView,
  memoryRows,
  processRows,
  sampleProcessLine,
  steppedSample,
  unlinkedLine,
} from './detail.ts';
import { phraseText, zoneFreeText } from './phrase.ts';
import { formatSpan } from './time.ts';

// A header line as written in UTC.
const header = (line: ReturnType<typeof headerLine>) =>
  `${line.lead}${phraseText(line.tail, 'UTC')}`;

// Tuesday 2026-10-06 16:00 UTC.
const NOW = Date.UTC(2026, 9, 6, 16, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

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
    collectorVersion: '0.6.0',
    lastSeenAt: NOW - 4 * SECOND,
    latest: { t: NOW - 4 * SECOND, uptimeSeconds: 6 * 86_400 + 3600 },
    platform: { arch: 'x64', os: 'linux' },
  };
  const none = {
    collectorVersion: undefined,
    lastSeenAt: undefined,
    latest: undefined,
    platform: undefined,
  };

  test('names the platform, Collector version, uptime, and last Report', () => {
    expect(header(headerLine(detail, NOW))).toBe(
      'Linux x64, Collector 0.6.0, up 6 d 1 h, last Report 4 s ago.',
    );
  });

  test('calls darwin macOS and leaves out what the Hub does not hold', () => {
    expect(
      header(
        headerLine(
          { ...none, lastSeenAt: NOW - 3 * DAY, platform: { arch: 'arm64', os: 'darwin' } },
          NOW,
        ),
      ),
    ).toBe('macOS arm64, last Report Sat 16:00.');
    expect(header(headerLine(none, NOW))).toBe('Never heard from.');
  });

  test('opens on the Collector version when the platform is unknown', () => {
    expect(
      header(
        headerLine(
          { ...detail, lastSeenAt: NOW - 2 * MINUTE, latest: undefined, platform: undefined },
          NOW,
        ),
      ),
    ).toBe('Collector 0.6.0, last Report 2 min ago.');
    expect(header(headerLine({ ...none, lastSeenAt: NOW - 3 * DAY }, NOW))).toBe(
      'Last Report Sat 16:00.',
    );
  });

  test('gives no uptime from a sample that is no longer current', () => {
    expect(
      header(
        headerLine(
          { ...detail, lastSeenAt: NOW - HOUR, latest: { t: NOW - HOUR, uptimeSeconds: 60 } },
          NOW,
        ),
      ),
    ).toBe('Linux x64, Collector 0.6.0, last Report 1 h ago.');
  });

  test('needs the zone only for a last Report a day or more old', () => {
    expect(headerLine(detail, NOW).tail).toEqual([]);
    expect(header(headerLine(detail, NOW))).toContain('up 6 d 1 h');
    const old = headerLine({ ...detail, lastSeenAt: NOW - 3 * DAY, latest: undefined }, NOW);
    expect(old.lead).toBe('Linux x64, Collector 0.6.0');
    expect(zoneFreeText(old.tail)).toBeUndefined();
  });

  test('ends the sentence in the part that ends it, so the lead alone has no stray full stop', () => {
    expect(headerLine(detail, NOW).lead).toMatch(/ago\.$/u);
    const old = headerLine({ ...none, lastSeenAt: NOW - 3 * DAY }, NOW);
    expect(old.lead).toBe('');
    expect(old.tail.at(-1)).toBe('.');
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

describe('the processes holding the most memory', () => {
  test('read as name, PID, and resident memory, largest first, and as nothing when none are named', () => {
    const holders = {
      processes: [
        { name: 'postgres', pid: 7, rssBytes: 4.25 * GIB },
        { name: 'bun', pid: 42, rssBytes: 300 * 1024 ** 2 },
      ],
      t: NOW,
    };
    expect(memoryHoldersView(holders)).toEqual({
      at: NOW,
      rows: [
        { name: 'postgres', pid: 7, resident: '4.3 GiB' },
        { name: 'bun', pid: 42, resident: '300 MiB' },
      ],
    });
    expect(memoryHoldersView({ processes: [], t: NOW })).toBeUndefined();
    expect(memoryHoldersView(undefined)).toBeUndefined();
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
      memoryRows(
        [
          {
            highBytes: 2 * GIB,
            lowBytes: 2 * GIB,
            t: NOW - 15 * MINUTE,
            totalBytes: 4 * GIB,
            usedBytes: 2 * GIB,
          },
        ],
        window,
      ),
    ).toEqual([
      { band: null, t: NOW - 20 * MINUTE + BUCKET / 2, used: null },
      { band: [2, 2], t: NOW - 15 * MINUTE + BUCKET / 2, used: 2 },
      { band: null, t: NOW - 10 * MINUTE + BUCKET / 2, used: null },
      { band: null, t: NOW - 5 * MINUTE + BUCKET / 2, used: null },
    ]);
  });

  test('give the 1-minute load per bucket, and null where a bucket has none, so the line breaks', () => {
    expect(
      loadRows([{ high: 4, low: 1, t: NOW - 15 * MINUTE, value: 2.5 }], window).map(
        ({ value }) => value,
      ),
    ).toEqual([null, 2.5, null, null]);
  });

  test('lay wider buckets with their low–high band, as a long range reads them', () => {
    const days = { from: NOW - 3 * DAY, to: NOW };
    const start = Math.floor(NOW / DAY) * DAY - DAY;
    expect(
      memoryRows(
        [{ highBytes: 3 * GIB, lowBytes: GIB, t: start, totalBytes: 4 * GIB, usedBytes: 2 * GIB }],
        days,
        DAY,
      ).find(({ used }) => used !== null),
    ).toEqual({ band: [1, 3], t: start + DAY / 2, used: 2 });
    expect(
      loadRows([{ high: 4, low: 1, t: start, value: 2.5 }], days, DAY).find(
        ({ value }) => value !== null,
      ),
    ).toEqual({ band: [1, 4], t: start + DAY / 2, value: 2.5 });
  });

  test("lay a long range's rows at the middle of each bucket the edges give, a 25-hour day as one", () => {
    const day = Date.UTC(2026, 10, 1, 7);
    const edges = [day - DAY, day, day + 25 * HOUR, day + 49 * HOUR];
    const span = { from: day - 12 * HOUR, to: day + 40 * HOUR };
    expect(loadRows([{ high: 4, low: 1, t: day, value: 2.5 }], span, DAY, edges)).toEqual([
      { band: null, t: day - 6 * HOUR, value: null },
      { band: [1, 4], t: day + 12.5 * HOUR, value: 2.5 },
      { band: null, t: day + 32.5 * HOUR, value: null },
    ]);
    expect(
      memoryRows(
        [{ highBytes: 3 * GIB, lowBytes: GIB, t: day, totalBytes: 4 * GIB, usedBytes: 2 * GIB }],
        span,
        DAY,
        edges,
      ).map(({ t }) => t),
    ).toEqual([day - 6 * HOUR, day + 12.5 * HOUR, day + 32.5 * HOUR]);
    expect(
      processRows(
        [
          {
            harness: 'codex',
            pid: 1,
            points: [{ cores: 1, t: day }],
            processId: 7,
            project: undefined,
          },
        ],
        span,
        DAY,
        edges,
      )[1],
    ).toEqual({ p7: 1, t: day + 12.5 * HOUR });
  });

  test("keep the newest bucket's point inside the window, at the middle of its part in it", () => {
    const day = Date.UTC(2026, 10, 1, 7);
    const edges = [day - DAY, day, day + 25 * HOUR, day + 49 * HOUR];
    const shown = { from: day - 12 * HOUR, to: day + 40 * HOUR };
    const points = loadRows([], shown, DAY, edges).map(({ t }) => t);

    expect(points.every((t) => t >= shown.from && t <= shown.to)).toBe(true);
    expect(points.at(-1)).toBe(day + 32.5 * HOUR);
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

const NO_MODIFIERS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

test('a key on the time axis moves the pinned sample a bucket, an hour with Shift or a page key, or to an end, within the window', () => {
  const window = { from: 0, to: 12 * 60 * MINUTE };
  const at = 6 * 60 * MINUTE;
  const step = (key: string, shift = false, selected = at) =>
    steppedSample({ ...NO_MODIFIERS, key, shiftKey: shift }, selected, window);

  expect([step('ArrowRight'), step('ArrowUp'), step('ArrowLeft'), step('ArrowDown')]).toEqual([
    at + 5 * MINUTE,
    at + 5 * MINUTE,
    at - 5 * MINUTE,
    at - 5 * MINUTE,
  ]);
  expect([
    step('ArrowRight', true),
    step('ArrowLeft', true),
    step('PageUp'),
    step('PageDown'),
  ]).toEqual([at + 60 * MINUTE, at - 60 * MINUTE, at + 60 * MINUTE, at - 60 * MINUTE]);
  expect([step('Home'), step('End')]).toEqual([window.from, window.to]);
  // With none pinned it starts from the newest; it never leaves the window.
  expect(steppedSample({ ...NO_MODIFIERS, key: 'ArrowLeft' }, undefined, window)).toBe(
    window.to - 5 * MINUTE,
  );
  expect(step('ArrowRight', false, window.to - MINUTE)).toBe(window.to);
  expect(step('PageDown', false, window.from + MINUTE)).toBe(window.from);
  expect(step('Enter')).toBeUndefined();
});

test('over a long range a key moves the pinned time a bucket, and 12 with Shift', () => {
  const window = { from: 0, to: 365 * DAY };
  const at = 100 * DAY;
  const step = (key: string, shiftKey = false) =>
    steppedSample({ ...NO_MODIFIERS, key, shiftKey }, at, window, DAY);
  expect([step('ArrowRight'), step('ArrowLeft', true)]).toEqual([at + DAY, at - 12 * DAY]);
});

test('over a long range with edges a key moves to the adjacent bucket, even on a 25-hour day', () => {
  const day = Date.UTC(2026, 10, 1, 7);
  const edges = [day - DAY, day, day + 25 * HOUR, day + 49 * HOUR, day + 73 * HOUR];
  const window = { from: day - 12 * HOUR, to: day + 60 * HOUR };
  const step = (key: string, selected: number, shiftKey = false) =>
    steppedSample({ ...NO_MODIFIERS, key, shiftKey }, selected, window, DAY, edges);

  // Half an hour into the 25-hour day, a nominal day's step would stay in it.
  expect(step('ArrowRight', day + 30 * MINUTE)).toBe(day + 37 * HOUR);
  expect(step('ArrowLeft', day + 30 * MINUTE)).toBe(day - 6 * HOUR);
  expect(step('ArrowLeft', day + 12.5 * HOUR)).toBe(day - 6 * HOUR);
  expect(step('ArrowRight', day + 37 * HOUR)).toBe(day + 54.5 * HOUR);
  expect(step('ArrowRight', day + 54.5 * HOUR)).toBe(day + 54.5 * HOUR);
  expect(step('ArrowLeft', day - 6 * HOUR, true)).toBe(day - 6 * HOUR);
  expect(step('PageUp', day - 6 * HOUR)).toBe(day + 54.5 * HOUR);
});

test('a key held with Alt, Ctrl, or Meta moves no pinned sample, so the browser keeps its shortcut', () => {
  const window = { from: 0, to: 12 * 60 * MINUTE };
  const held = (modifier: 'altKey' | 'ctrlKey' | 'metaKey', key: string) =>
    steppedSample({ ...NO_MODIFIERS, [modifier]: true, key }, 6 * 60 * MINUTE, window);

  expect([
    held('altKey', 'ArrowLeft'),
    held('ctrlKey', 'Home'),
    held('metaKey', 'ArrowRight'),
  ]).toEqual([undefined, undefined, undefined]);
});
