import { describe, expect, test } from 'bun:test';

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import { phraseText } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import {
  HISTORY_LIMIT,
  historyRows,
  listedRows,
  newestReceived,
  stopRow,
  stopSummary,
  stripTicks,
  supervisorLine,
} from './service-detail.ts';

// Saturday 2026-10-24 12:00 UTC, 08:00 in New York.
const NOW = Date.UTC(2026, 9, 24, 12, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const utc = (text: Phrase) => phraseText(text, 'UTC');

const stop = (over: Partial<ServiceStop> = {}): ServiceStop => ({
  exitStatus: 0,
  ongoing: false,
  paired: true,
  receivedAt: new Date(NOW - HOUR + 5 * SECOND).toISOString(),
  restarts: 0,
  result: 'success',
  sentAt: new Date(NOW - HOUR + 5 * SECOND).toISOString(),
  service: 'web',
  startedAt: new Date(NOW - HOUR + 2 * SECOND).toISOString(),
  stoppedAt: new Date(NOW - HOUR).toISOString(),
  system: 'laptop-1',
  ...over,
});

const at = (ms: number) => new Date(ms).toISOString();

const row = (over: Partial<ServiceStop>) => stopRow(stop(over), NOW);

describe('result words', () => {
  test('a clean stop is good', () => {
    expect(row({})).toMatchObject({ dot: 'good', failure: false });
    expect(utc(row({}).title)).toBe('Stopped cleanly');
  });

  test('an unknown result is a ring and the details say why', () => {
    const unknown = row({ exitStatus: null, result: null });
    expect(unknown.dot).toBe('unknown');
    expect(unknown.failure).toBe(false);
    expect(utc(unknown.title)).toBe('Result unknown');
    const result = unknown.details.find(({ label }) => label === 'Result');
    expect(utc(result?.value ?? [])).toContain('ran again between two checks');
  });

  test('a signal, an exit code, and another word are critical', () => {
    expect(utc(row({ exitStatus: 9, result: 'signal' }).title)).toBe('Killed, signal 9');
    expect(utc(row({ exitStatus: 1, result: 'exit-code' }).title)).toBe('Failed, exit-code 1');
    expect(utc(row({ exitStatus: 3, result: 'timeout' }).title)).toBe(
      'Stopped: timeout, exit status 3',
    );
    expect(utc(row({ exitStatus: null, result: 'timeout' }).title)).toBe('Stopped: timeout');
    for (const result of ['signal', 'exit-code', 'timeout']) {
      expect(row({ result })).toMatchObject({ dot: 'bad', failure: true });
    }
  });

  test('restarts show only when there are some', () => {
    expect(row({ restarts: 0 }).restarts).toBeUndefined();
    expect(row({ restarts: 1 }).restarts).toBe('1 restart');
    expect(row({ restarts: 37 }).restarts).toBe('37 restarts');
  });
});

describe('how long it was down', () => {
  test('is the span from stopping to running again', () => {
    expect(
      row({ startedAt: at(NOW - HOUR + 85 * SECOND), stoppedAt: at(NOW - HOUR) }).duration,
    ).toBe('1 min');
  });

  test('an unknown end says so', () => {
    expect(row({ ongoing: false, startedAt: null }).duration).toBe('End unknown');
  });

  test('an ongoing stop reads still down since, and how long so far', () => {
    const ongoing = row({ ongoing: true, startedAt: null, stoppedAt: at(NOW - 3 * HOUR) });
    expect(utc(ongoing.title)).toBe('Still down since 09:00');
    expect(ongoing.dot).toBe('bad');
    expect(ongoing.duration).toBe('3 h');
  });
});

const late = (afterMs: number) =>
  row({ receivedAt: at(NOW - HOUR + afterMs), sentAt: at(NOW - HOUR) }).late;

describe('late delivery', () => {
  test('only when received more than 2 minutes after it was sent', () => {
    expect(late(2 * MINUTE)).toBeUndefined();
    expect(late(2 * MINUTE + SECOND)).toBe('2 min');
    expect(late(6 * HOUR)).toBe('6 h');
    expect(late(-MINUTE)).toBeUndefined();
  });
});

const down = (over: Partial<ServiceDownTransition> = {}): ServiceDownTransition => ({
  at: NOW - 3 * HOUR,
  condition: '7',
  kind: 'raised',
  reason: 'Stopped: ActiveState=failed',
  ...over,
});

const shape = (rows: ReturnType<typeof historyRows>) =>
  rows.map((found) => [found.kind, (NOW - found.at) / HOUR]);

describe('history', () => {
  test('stops and Service down raises and clears in one list, newest first', () => {
    const rows = historyRows(
      [stop({ stoppedAt: at(NOW - 5 * HOUR) }), stop({ stoppedAt: at(NOW - HOUR) })],
      [down(), down({ at: NOW - 2 * HOUR, kind: 'cleared' })],
      [],
      [],
      NOW,
    );
    expect(shape(rows)).toEqual([
      ['stop', 1],
      ['downCleared', 2],
      ['downRaised', 3],
      ['stop', 5],
    ]);
  });

  test('a raise says why, links its Condition, and how long the Service was down', () => {
    const raised = historyRows(
      [],
      [
        down({ condition: '9' }),
        down({ at: NOW - 3 * HOUR + 4 * MINUTE, condition: '9', kind: 'cleared' }),
      ],
      [],
      [],
      NOW,
    ).find((found) => found.kind === 'downRaised');
    expect(raised).toEqual({
      at: NOW - 3 * HOUR,
      condition: '9',
      duration: '4 min',
      kind: 'downRaised',
      reason: 'Stopped: ActiveState=failed',
    });
  });

  test('a raise still open counts how long so far', () => {
    const [raised] = historyRows([], [down({ at: NOW - 100 * DAY })], [], [], NOW);
    expect(raised).toMatchObject({ duration: '100 d', kind: 'downRaised' });
  });

  test('a stop still down keeps its place in time', () => {
    const rows = historyRows(
      [
        stop({ ongoing: true, startedAt: null, stoppedAt: at(NOW - 30 * HOUR) }),
        stop({ stoppedAt: at(NOW - HOUR) }),
      ],
      [],
      [],
      [],
      NOW,
    );
    expect(shape(rows)).toEqual([
      ['stop', 1],
      ['stop', 30],
    ]);
  });

  test('transitions at the same time list the later recorded first', () => {
    const rows = historyRows([], [down(), down({ kind: 'cleared' })], [], [], NOW);
    expect(rows.map(({ kind }) => kind)).toEqual(['downCleared', 'downRaised']);
  });

  test('a change of installed version joins the history, saying what it was', () => {
    const rows = historyRows(
      [stop({ stoppedAt: at(NOW - HOUR) })],
      [],
      [{ at: NOW - 2 * HOUR, version: '1.28', was: '1.27' }],
      [],
      NOW,
    );
    expect(shape(rows)).toEqual([
      ['stop', 1],
      ['installed', 2],
    ]);
    expect(rows[1]).toEqual({
      at: NOW - 2 * HOUR,
      kind: 'installed',
      version: '1.28',
      was: '1.27',
    });
  });

  test('the list shows the newest 6 until asked for all', () => {
    const rows = historyRows(
      Array.from({ length: 8 }, (_, index) => stop({ stoppedAt: at(NOW - (index + 1) * HOUR) })),
      [],
      [],
      [],
      NOW,
    );
    expect(HISTORY_LIMIT).toBe(6);
    expect(listedRows(rows, false)).toEqual({ hidden: 2, shown: rows.slice(0, 6) });
    expect(listedRows(rows, true)).toEqual({ hidden: 0, shown: rows });
    expect(listedRows(rows.slice(0, 6), false)).toEqual({ hidden: 0, shown: rows.slice(0, 6) });
  });
});

const height = (restarts: number) =>
  stripTicks([stop({ restarts, stoppedAt: at(NOW - HOUR) })], NOW)[0]?.height;

describe('summary and strip', () => {
  const stops = [
    stop({ exitStatus: 1, restarts: 8, result: 'exit-code', stoppedAt: at(NOW - 2 * HOUR) }),
    stop({ stoppedAt: at(NOW - 20 * HOUR) }),
    stop({ stoppedAt: at(NOW - 3 * DAY) }),
    stop({ stoppedAt: at(NOW - 100 * DAY) }),
  ];

  test('counts the stops in the 90 days and the last 24 hours', () => {
    expect(stopSummary(stops, NOW)).toEqual({ last24h: 2, total: 3 });
  });

  test('a stop still down from before the 90 days is listed but neither counted nor drawn', () => {
    const old = stop({ ongoing: true, startedAt: null, stoppedAt: at(NOW - 100 * DAY) });
    expect(stopSummary([old], NOW)).toEqual({ last24h: 0, total: 0 });
    expect(stripTicks([old], NOW)).toEqual([]);
    expect(historyRows([old], [], [], [], NOW)).toHaveLength(1);
  });

  test('a tick sits at its stop in the window, tall for restarts, serious for failure', () => {
    const ticks = stripTicks(stops, NOW);
    expect(ticks).toHaveLength(3);
    const [failed, clean] = ticks;
    expect(failed).toMatchObject({ failure: true, height: 100 });
    expect(failed?.left).toBeCloseTo(100 - (2 / (90 * 24)) * 100, 5);
    expect(clean).toMatchObject({ failure: false, height: 40 });
  });

  test('height caps and rises with restarts', () => {
    expect(height(0)).toBe(40);
    expect(height(2)).toBe(55);
    expect(height(8)).toBe(100);
    expect(height(500)).toBe(100);
  });

  test('the newest stop received is the last one the Hub took', () => {
    expect(newestReceived([], NOW)).toBeUndefined();
    expect(
      newestReceived(
        [stop({ receivedAt: at(NOW - 3 * MINUTE) }), stop({ receivedAt: at(NOW - 2 * DAY) })],
        NOW,
      ),
    ).toBe('3 min ago');
    expect(newestReceived([stop({ receivedAt: at(NOW - 10 * SECOND) })], NOW)).toBe('just now');
  });
});

describe('header', () => {
  test('the supervisor line names the supervisor and its unit', () => {
    expect(supervisorLine('systemd', 'web.service')).toBe('systemd · web.service');
    expect(supervisorLine('docker', 'ollama')).toBe('Docker · ollama');
    expect(supervisorLine('none', undefined)).toBeUndefined();
    expect(supervisorLine('systemd', undefined)).toBe('systemd');
  });
});
