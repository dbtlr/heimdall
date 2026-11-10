import { describe, expect, test } from 'bun:test';

import type { ConditionLevel } from '@heimdall/schema';

import type { Attention } from '../server/attention-types.ts';
import type { SystemGlance } from '../server/fleet-overview-types.ts';
import { diskReading, meterLevels, tileOrder, tileStatusWords } from './fleet-tile.ts';

const condition = (over: Partial<Extract<Attention, { kind: 'low_disk' }>> = {}): Attention => ({
  checkedAt: 100,
  conditionId: 'c-1',
  disk: undefined,
  evidence: 'current',
  firstDetected: 100,
  kind: 'low_disk',
  level: 'note',
  reason: 'Disk use above the Hub limit',
  subject: '/',
  system: 'server-1',
  unpaired: false,
  ...over,
});

const cpu = (level: ConditionLevel, kind: 'high_cpu' | 'high_memory' = 'high_cpu'): Attention => ({
  checkedAt: 100,
  conditionId: 'c-cpu',
  evidence: 'current',
  firstDetected: 100,
  kind,
  level,
  reason: 'CPU busy',
  subject: '',
  system: 'server-1',
  unpaired: false,
});

const reboot = (level: ConditionLevel): Attention => ({
  checkedAt: 100,
  conditionId: 'c-reboot',
  evidence: 'current',
  firstDetected: 100,
  kind: 'reboot_required',
  level,
  reason: 'Reboot pending',
  subject: '',
  system: 'server-1',
  unpaired: false,
});

const lane = (name: string, over: Partial<SystemGlance> = {}): SystemGlance => ({
  lastSeenAt: 1_000_000,
  latest: undefined,
  name,
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  ...over,
});

describe('meterLevels', () => {
  test('a Condition colors the meter of the resource it holds on', () => {
    expect(meterLevels([condition({ level: 'note' })])).toEqual({ disk: 'note' });
    expect(meterLevels([cpu('alert', 'high_memory')])).toEqual({ memory: 'alert' });
  });

  test('High CPU colors no meter, because a tile draws its CPU as a sparkline', () => {
    expect(meterLevels([cpu('warning')])).toEqual({});
  });

  test('a meter takes the worst level among the Conditions on it', () => {
    const levels = meterLevels([
      condition({ level: 'note', subject: '/' }),
      condition({ level: 'alert', subject: '/data' }),
      condition({ level: 'warning', subject: '/var' }),
    ]);

    expect(levels).toEqual({ disk: 'alert' });
  });

  test('Conditions about no resource, and evidence without a level, color nothing', () => {
    const missing: Attention = {
      checkedAt: undefined,
      evidence: 'old',
      firstDetected: 0,
      kind: 'checks_missing',
      set: 'checks',
      subject: '',
      system: 'server-1',
      unpaired: false,
    };

    expect(meterLevels([reboot('alert'), missing])).toEqual({});
  });
});

describe('tileOrder', () => {
  test('puts alerts first, then warnings, then awake before asleep, then by name', () => {
    const now = 10_000_000;
    const lanes = [
      lane('delta'),
      lane('charlie', { lastSeenAt: 0, sleeps: true }),
      lane('bravo'),
      lane('alpha'),
      lane('echo'),
    ];
    const items = [
      condition({ level: 'warning', system: 'bravo' }),
      condition({ level: 'alert', system: 'echo' }),
      condition({ level: 'note', system: 'delta' }),
    ];

    const tiles = tileOrder(lanes, items, now);

    expect(tiles.map((tile) => tile.lane.name)).toEqual([
      'echo',
      'bravo',
      'alpha',
      'delta',
      'charlie',
    ]);
    expect(tiles.map((tile) => tile.level)).toEqual([
      'alert',
      'warning',
      undefined,
      undefined,
      undefined,
    ]);
    expect(tiles.at(-1)?.asleep).toBe(true);
  });

  test('a tile carries only the items of its own System', () => {
    const items = [condition({ system: 'a' }), condition({ system: 'b' })];

    const [tile] = tileOrder([lane('a')], items, 0);

    expect(tile?.items).toEqual(items.slice(0, 1));
  });

  test("a tile leaves out its System's maintenance notes and keeps a Reboot required at warning", () => {
    const items = [reboot('note'), reboot('warning'), condition()];

    const [tile] = tileOrder([lane('server-1')], items, 0);

    expect(tile?.items).toEqual(items.slice(1));
  });
});

describe('tileStatusWords', () => {
  const now = 100_000_000;
  const words = (over: Parameters<typeof lane>[1]) => {
    const [tile] = tileOrder([lane('a', over)], [], now);
    return tile === undefined ? undefined : tileStatusWords(tile, now);
  };

  test('an up System is healthy, an asleep one says how long it has slept, and one never seen has no Report', () => {
    expect(words({ lastSeenAt: now - 5000 })).toBe('Healthy');
    expect(words({ lastSeenAt: now - 20 * 3_600_000, sleeps: true, status: 'asleep' })).toBe(
      'Asleep 20 h',
    );
    expect(words({ lastSeenAt: undefined, status: 'never_seen' })).toBe('No Report yet');
  });
});

describe('diskReading', () => {
  const disks = [
    { mount: '/', totalBytes: 100, usedBytes: 40 },
    { mount: '/data', totalBytes: 100, usedBytes: 90 },
    { mount: '/var', totalBytes: 100, usedBytes: 70 },
  ];

  test('without a low_disk Condition it reads the fullest mount', () => {
    expect(diskReading(disks, [])).toEqual({ mount: '/data', percent: 90 });
  });

  test('a low_disk Condition makes it read the mount the Condition names, not the fullest', () => {
    expect(diskReading(disks, [condition({ subject: '/' })])).toEqual({ mount: '/', percent: 40 });
  });

  test('with several low_disk Conditions it reads the mount of the worst level', () => {
    const items = [
      condition({ level: 'warning', subject: '/data' }),
      condition({ level: 'alert', subject: '/var' }),
      condition({ level: 'note', subject: '/' }),
    ];

    expect(diskReading(disks, items)).toEqual({ mount: '/var', percent: 70 });
  });

  test('a low_disk mount the newest sample lacks falls back to the fullest mount', () => {
    expect(diskReading(disks, [condition({ subject: '/gone' })])).toEqual({
      mount: '/data',
      percent: 90,
    });
  });

  test('a System with no disks reads nothing', () => {
    expect(diskReading([], [condition()])).toBeUndefined();
  });
});
