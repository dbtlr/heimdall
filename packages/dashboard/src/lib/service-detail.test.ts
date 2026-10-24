import { describe, expect, test } from 'bun:test';

import type { ServiceStop } from '../server/service-detail-types.ts';
import { phraseText } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import {
  dayGroups,
  LIST_LIMIT,
  newestReceived,
  stopRows,
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

const row = (over: Partial<ServiceStop>) => {
  const [only] = stopRows([stop(over)], NOW);
  if (only === undefined) {
    throw new Error('no row');
  }
  return only;
};

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

describe('order and limit', () => {
  test('newest first, an ongoing stop with an unknown start before all', () => {
    const rows = stopRows(
      [
        stop({ stoppedAt: at(NOW - 5 * HOUR) }),
        stop({ ongoing: true, startedAt: null, stoppedAt: at(NOW - 30 * HOUR) }),
        stop({ stoppedAt: at(NOW - HOUR) }),
      ],
      NOW,
    );
    expect(rows.map(({ stoppedAt }) => NOW - stoppedAt)).toEqual([30 * HOUR, HOUR, 5 * HOUR]);
  });

  test('the list shows 50 stops', () => {
    expect(LIST_LIMIT).toBe(50);
  });
});

describe('day groups', () => {
  const NEW_YORK = 'America/New_York';

  test('group by the viewer zone, across its midnight', () => {
    // 03:30 UTC is 23:30 the day before in New York; 05:00 UTC is 01:00 today.
    const rows = stopRows(
      [
        stop({ stoppedAt: at(Date.UTC(2026, 9, 24, 5, 0)) }),
        stop({ stoppedAt: at(Date.UTC(2026, 9, 24, 3, 30)) }),
        stop({ stoppedAt: at(Date.UTC(2026, 9, 19, 18, 0)) }),
      ],
      NOW,
    );
    expect(dayGroups(rows, NOW, NEW_YORK).map(({ label, rows: of }) => [label, of.length])).toEqual(
      [
        ['Today', 1],
        ['Yesterday', 1],
        ['Monday 19 Oct', 1],
      ],
    );
    expect(dayGroups(rows, NOW, 'UTC').map(({ label, rows: of }) => [label, of.length])).toEqual([
      ['Today', 2],
      ['Monday 19 Oct', 1],
    ]);
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
