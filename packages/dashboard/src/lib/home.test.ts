import { describe, expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import type { TileGlance } from '../server/home-types.ts';
import { homeFigures, homeVerdict, pickAttention } from './home.ts';
import { zoneFreeText } from './phrase.ts';

const NOW = 100 * 24 * 60 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const lane = (name: string, over: Partial<TileGlance> = {}): TileGlance => ({
  cpu: [],
  gaps: [],
  lastSeenAt: NOW - 5000,
  latest: undefined,
  name,
  services: { total: 2, up: 2 },
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  ...over,
});

const memory = (over: Partial<Attention> = {}): Attention =>
  ({
    checkedAt: NOW,
    conditionId: '1',
    evidence: 'current',
    firstDetected: NOW - 25 * HOUR,
    kind: 'high_memory',
    level: 'warning',
    reason: 'Memory above 90%',
    subject: '',
    system: 'server-1',
    unpaired: false,
    ...over,
  }) as Attention;

const down = (over: Partial<Attention> = {}): Attention =>
  ({
    checkedAt: NOW,
    checks: [],
    conditionId: '2',
    evidence: 'current',
    firstDetected: NOW - 4 * MINUTE,
    kind: 'service_down',
    level: 'alert',
    reason: 'stopped',
    service: undefined,
    subject: 'proxy',
    system: 'edge-1',
    unpaired: false,
    ...over,
  }) as Attention;

const note = (over: Partial<Attention> = {}): Attention =>
  ({
    checkedAt: NOW,
    conditionId: '3',
    disk: undefined,
    evidence: 'current',
    firstDetected: NOW - HOUR,
    kind: 'low_disk',
    level: 'note',
    reason: '76% used',
    subject: '/data',
    system: 'server-1',
    unpaired: false,
    ...over,
  }) as Attention;

const verdict = (attention: Attention[], lanes = [lane('server-1'), lane('edge-1')], over = {}) =>
  homeVerdict({ attention, deliveryFailingSince: undefined, lanes, now: NOW, ...over });

const support = (attention: Attention[], lanes?: TileGlance[], over = {}) =>
  zoneFreeText(verdict(attention, lanes, over).support);

describe('homeVerdict', () => {
  test('a lone Service down alert names the Service and its System, and says how long it has been down', () => {
    const result = verdict([down()]);

    expect(result.level).toBe('alert');
    expect(result.sentence).toBe('proxy is down on edge-1.');
    expect(support([down()])).toStartWith('Down for 4 min.');
  });

  test('a lone alert of another kind names the Condition and its System', () => {
    const result = verdict([memory({ level: 'alert' })]);

    expect(result.sentence).toBe('High memory on server-1.');
    expect(support([memory({ level: 'alert' })])).toStartWith('Open for 1 d 1 h. Nothing is down.');
  });

  test('several alerts are counted, and the newest is named', () => {
    const items = [
      down(),
      down({ conditionId: '4', firstDetected: NOW - HOUR, subject: 'db' }),
      memory({ level: 'alert' }),
    ];

    expect(verdict(items).sentence).toBe('3 things need you now.');
    expect(support(items)).toStartWith(
      'The newest is Service down proxy on edge-1, open for 4 min. 2 Services are down.',
    );
  });

  test('one warning says one System needs the operator this week', () => {
    const result = verdict([memory()]);

    expect(result.level).toBe('warning');
    expect(result.sentence).toBe('One System needs you this week.');
    expect(support([memory()])).toBe(
      'High memory on server-1 has been open for 1 d 1 h. Nothing is down.',
    );
  });

  test('warnings count the Systems they are on, not the warnings', () => {
    const items = [
      memory(),
      memory({ conditionId: '5', kind: 'high_cpu' }),
      memory({ conditionId: '6', system: 'edge-1' }),
    ];

    expect(verdict(items).sentence).toBe('2 Systems need you this week.');
  });

  test('notes alone leave the fleet healthy, and only the supporting line mentions them', () => {
    const result = verdict([note(), note({ conditionId: '7', subject: '/' })]);

    expect(result.level).toBe('healthy');
    expect(result.sentence).toBe('Everything is healthy.');
    expect(zoneFreeText(result.support)).toBe(
      'Every System reports and every Service is up. 2 notes can wait.',
    );
  });

  test('the notes that can wait leave out maintenance notes', () => {
    const reboot = note({ conditionId: '8', kind: 'reboot_required', subject: '' });

    expect(zoneFreeText(verdict([note(), reboot]).support)).toBe(
      'Every System reports and every Service is up. One note can wait.',
    );
  });

  test('with nothing open the fleet is healthy, and the line says what holds back the all-clear', () => {
    const lanes = [
      lane('server-1', { services: { total: 3, up: 2 } }),
      lane('edge-1', { silencedUntil: NOW + 2 * HOUR }),
    ];

    expect(verdict([], lanes).sentence).toBe('Everything is healthy.');
    expect(support([], lanes)).toBe('Nothing is down. Alerts on edge-1 are silenced for 2 h.');
  });

  test('a failing alert delivery is stated with when it began', () => {
    const { support: line } = verdict([], undefined, { deliveryFailingSince: NOW - HOUR });

    expect(line).toContainEqual({ at: NOW - HOUR, format: 'when', now: NOW });
    expect(line.filter((part) => typeof part === 'string').join('')).toContain(
      'Alert delivery has failed since ',
    );
  });

  test('every System asleep is still healthy, and says so', () => {
    const asleep = { lastSeenAt: NOW - 3 * HOUR, sleeps: true, status: 'asleep' as const };
    const result = verdict([], [lane('laptop-1', asleep), lane('laptop-2', asleep)]);

    expect(result.sentence).toBe('Everything is healthy.');
    expect(zoneFreeText(result.support)).toBe('Nothing is down. Every System is asleep.');
  });

  test('one System asleep is named', () => {
    const lanes = [
      lane('server-1'),
      lane('laptop-1', { lastSeenAt: NOW - 3 * HOUR, sleeps: true, status: 'asleep' }),
    ];

    expect(support([], lanes)).toBe('Nothing is down. laptop-1 is asleep.');
  });

  test('with no System paired it says so, and nothing else', () => {
    const result = verdict([], []);

    expect(result).toEqual({ level: 'empty', sentence: 'No System is paired.', support: [] });
  });

  test('with no System paired or none reported yet, a failing alert delivery is still stated', () => {
    for (const lanes of [[], [lane('server-1', { lastSeenAt: undefined, status: 'never_seen' })]]) {
      const result = verdict([], lanes, { deliveryFailingSince: NOW - HOUR });

      expect(result.level).toBe('empty');
      expect(result.support).toContainEqual({ at: NOW - HOUR, format: 'when', now: NOW });
    }
  });

  test('a lone Service down alert never adds that nothing is down', () => {
    expect(support([down()])).toBe('Down for 4 min.');
    expect(support([down(), down({ conditionId: '4', level: 'warning', subject: 'db' })])).toBe(
      'Down for 4 min. One other Service is down.',
    );
  });

  test('unpaired Systems and their items never change the verdict', () => {
    expect(verdict([down({ unpaired: true })]).sentence).toBe('Everything is healthy.');
    expect(verdict([memory({ unpaired: true })]).sentence).toBe('Everything is healthy.');
    expect(support([memory(), down({ level: 'warning', unpaired: true })])).toBe(
      'High memory on server-1 has been open for 1 d 1 h. Nothing is down.',
    );
  });

  test('a silence that has ended is not mentioned', () => {
    const lanes = [lane('server-1'), lane('edge-1', { silencedUntil: NOW - MINUTE })];

    expect(support([], lanes)).toBe('Every System reports and every Service is up.');
  });

  test('a fleet of one asleep System names it', () => {
    const asleep = { lastSeenAt: NOW - 3 * HOUR, sleeps: true, status: 'asleep' as const };

    expect(support([], [lane('laptop-1', asleep)])).toBe('Nothing is down. laptop-1 is asleep.');
  });
});

describe('pickAttention', () => {
  test('leads with the worst level, then the newest, and lists the rest in that order', () => {
    const oldAlert = down({ conditionId: 'a', firstDetected: NOW - 2 * HOUR });
    const newAlert = down({ conditionId: 'b', firstDetected: NOW - MINUTE });
    const warning = memory({ conditionId: 'c', firstDetected: NOW });

    const { lead, rest } = pickAttention([warning, oldAlert, newAlert]);

    expect(lead?.conditionId).toBe('b');
    expect(rest.map(({ conditionId }) => conditionId)).toEqual(['a', 'c']);
  });

  test('breaks a tie in age by System, then Condition, then subject', () => {
    const at = NOW - HOUR;
    const items = [
      memory({ conditionId: 'd', firstDetected: at, kind: 'high_cpu', system: 'edge-1' }),
      memory({ conditionId: 'c', firstDetected: at, system: 'server-1' }),
      memory({ conditionId: 'b', firstDetected: at, system: 'edge-1' }),
      note({ conditionId: 'a', firstDetected: at, level: 'warning', subject: '/var' }),
      note({ conditionId: 'e', firstDetected: at, level: 'warning', subject: '/' }),
    ];

    const { lead, rest } = pickAttention(items);

    expect([lead, ...rest].map((item) => item?.conditionId)).toEqual(['d', 'b', 'c', 'e', 'a']);
  });

  test('leaves out notes, unpaired items, and paired Service restarted notes', () => {
    const restarted = { ...note(), kind: 'service_restarted', service: undefined } as Attention;

    expect(pickAttention([note(), down({ unpaired: true }), restarted])).toEqual({
      lead: undefined,
      rest: [],
    });
  });

  test('leaves out evidence the Hub holds no Condition for, which its tile still shows', () => {
    const missing: Attention = {
      checkedAt: undefined,
      evidence: 'old',
      firstDetected: NOW,
      kind: 'checks_missing',
      set: 'checks',
      subject: '',
      system: 'server-1',
      unpaired: false,
    };

    expect(pickAttention([missing, memory()]).lead?.kind).toBe('high_memory');
    expect(pickAttention([missing, memory()]).rest).toEqual([]);
    expect(pickAttention([missing]).lead).toBeUndefined();
  });
});

describe('homeFigures', () => {
  test('counts the Systems heard from within the quiet limit, and the Services up', () => {
    const lanes = [
      lane('server-1', { services: { total: 3, up: 2 } }),
      lane('laptop-1', { lastSeenAt: NOW - 3 * HOUR, services: { total: 1, up: 0 } }),
      lane('new-1', { lastSeenAt: undefined, services: { total: 0, up: 0 } }),
    ];

    expect(homeFigures(lanes, NOW)).toEqual({ awake: 1, services: 4, servicesUp: 2, systems: 3 });
  });
});
