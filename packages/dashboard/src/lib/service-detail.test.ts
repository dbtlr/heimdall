import { describe, expect, test } from 'bun:test';

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import { phraseText } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import {
  HISTORY_LIMIT,
  historyRows,
  listedRows,
  stopLines,
  supervisorLine,
} from './service-detail.ts';

// Saturday 2026-10-24 12:00 UTC, 08:00 in New York.
const NOW = Date.UTC(2026, 9, 24, 12, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const utc = (text: Phrase) => phraseText(text, 'UTC');

const at = (ms: number) => new Date(ms).toISOString();

const stop = (over: Partial<ServiceStop> = {}): ServiceStop => ({
  exitStatus: 0,
  ongoing: false,
  paired: true,
  receivedAt: at(NOW - HOUR + 5 * SECOND),
  restarts: 0,
  result: 'success',
  sentAt: at(NOW - HOUR + 5 * SECOND),
  service: 'web',
  startedAt: at(NOW - HOUR + 2 * SECOND),
  stoppedAt: at(NOW - HOUR),
  system: 'laptop-1',
  ...over,
});

const down = (over: Partial<ServiceDownTransition> = {}): ServiceDownTransition => ({
  at: NOW - 3 * HOUR,
  condition: '7',
  kind: 'raised',
  reason: 'Stopped: ActiveState=failed',
  ...over,
});

const line = (over: Partial<ServiceStop>, downs: ServiceDownTransition[] = []) => {
  const [found] = stopLines([stop(over)], downs, NOW);
  if (found === undefined) {
    throw new Error('No line.');
  }
  return found;
};

describe('a stop line', () => {
  test('says how the stop ended', () => {
    expect(utc(line({}).result)).toBe('Stopped cleanly');
    expect(utc(line({ exitStatus: null, result: null }).result)).toBe('Result unknown');
    expect(utc(line({ exitStatus: 9, result: 'signal' }).result)).toBe('Killed, signal 9');
    expect(utc(line({ exitStatus: 1, result: 'exit-code' }).result)).toBe('Failed, exit-code 1');
    expect(utc(line({ exitStatus: 3, result: 'timeout' }).result)).toBe(
      'Stopped: timeout, exit status 3',
    );
    expect(utc(line({ exitStatus: null, result: 'timeout' }).result)).toBe('Stopped: timeout');
  });

  test('is the span from stopping to running again', () => {
    expect(
      line({ startedAt: at(NOW - HOUR + 85 * SECOND), stoppedAt: at(NOW - HOUR) }).duration,
    ).toBe('1 min');
  });

  test('an unknown end says so', () => {
    expect(line({ ongoing: false, startedAt: null }).duration).toBe('End unknown');
  });

  test('an ongoing stop is down, reads still down since, and counts how long so far', () => {
    const ongoing = line({ ongoing: true, startedAt: null, stoppedAt: at(NOW - 3 * HOUR) });
    expect(utc(ongoing.result)).toBe('Still down since 09:00');
    expect(ongoing).toMatchObject({ down: true, duration: '3 h' });
  });

  test('is down only when the Service down Condition was open over it', () => {
    expect(line({}).down).toBe(false);
    expect(
      line({}, [down({ at: NOW - 3 * HOUR }), down({ at: NOW - 2 * HOUR, kind: 'cleared' })]).down,
    ).toBe(false);
    expect(line({}, [down()]).down).toBe(true);
    expect(line({}, [down(), down({ at: NOW - 2 * HOUR, kind: 'cleared' })]).down).toBe(false);
  });

  test('lines run newest first', () => {
    const lines = stopLines(
      [stop({ stoppedAt: at(NOW - 5 * HOUR) }), stop({ stoppedAt: at(NOW - HOUR) })],
      [],
      NOW,
    );
    expect(lines.map(({ stoppedAt }) => (NOW - stoppedAt) / HOUR)).toEqual([1, 5]);
  });
});

const shape = (rows: ReturnType<typeof historyRows>) =>
  rows.map((found) => [found.kind, (NOW - found.at) / HOUR]);

describe('history', () => {
  test('Service down raises and clears in one list, newest first', () => {
    const rows = historyRows([down(), down({ at: NOW - 2 * HOUR, kind: 'cleared' })], [], [], NOW);
    expect(shape(rows)).toEqual([
      ['downCleared', 2],
      ['downRaised', 3],
    ]);
  });

  test('a raise says why, links its Condition, and how long the Service was down', () => {
    const raised = historyRows(
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
    const [raised] = historyRows([down({ at: NOW - 100 * DAY })], [], [], NOW);
    expect(raised).toMatchObject({ duration: '100 d', kind: 'downRaised' });
  });

  test('transitions at the same time list the later recorded first', () => {
    const rows = historyRows([down(), down({ kind: 'cleared' })], [], [], NOW);
    expect(rows.map(({ kind }) => kind)).toEqual(['downCleared', 'downRaised']);
  });

  test('a change of installed version joins the history, saying what it was', () => {
    const rows = historyRows(
      [down({ at: NOW - HOUR })],
      [{ at: NOW - 2 * HOUR, version: '1.28', was: '1.27' }],
      [],
      NOW,
    );
    expect(shape(rows)).toEqual([
      ['downRaised', 1],
      ['installed', 2],
    ]);
    expect(rows[1]).toEqual({
      at: NOW - 2 * HOUR,
      kind: 'installed',
      version: '1.28',
      was: '1.27',
    });
  });

  test('a list shows the newest 6 until asked for all', () => {
    const rows = Array.from({ length: 8 }, (_, index) => index);
    expect(HISTORY_LIMIT).toBe(6);
    expect(listedRows(rows, false)).toEqual({ hidden: 2, shown: rows.slice(0, 6) });
    expect(listedRows(rows, true)).toEqual({ hidden: 0, shown: rows });
    expect(listedRows(rows.slice(0, 6), false)).toEqual({ hidden: 0, shown: rows.slice(0, 6) });
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
