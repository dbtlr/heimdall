import { expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import { DELIVERY_FAILING_SHOWN_AFTER_MS } from '../server/fleet-overview-types.ts';
import { canWaitRows } from './fleet-tile.ts';
import { deliveryFailingShown, fleetAttention, isAsleep } from './fleet.ts';

const disk = (over: Partial<Extract<Attention, { kind: 'low_disk' }>> = {}): Attention => ({
  checkedAt: 100,
  disk: undefined,
  evidence: 'current',
  firstDetected: 100,
  kind: 'low_disk',
  level: 'warning',
  reason: 'Disk use above the Hub limit',
  subject: '/',
  system: 'server-1',
  unpaired: false,
  ...over,
});

test('sleep is a freshness fact independent of any open Condition', () => {
  expect(isAsleep({ lastSeenAt: 0, sleeps: true }, 120_001)).toBe(true);
  expect(isAsleep({ lastSeenAt: 0, sleeps: true }, 120_000)).toBe(false);
  expect(isAsleep({ lastSeenAt: 0, sleeps: false }, 120_001)).toBe(false);
  expect(isAsleep({ lastSeenAt: undefined, sleeps: true }, 120_001)).toBe(false);
});

test('Fleet orders stored levels before freshness and excludes unpaired history from its counts', () => {
  const warning = disk();
  const note = disk({ level: 'note' });
  const oldAlert = disk({ evidence: 'old', firstDetected: 1, level: 'alert' });
  const input = [warning, note, oldAlert, disk({ level: 'alert', unpaired: true })];

  const result = fleetAttention(input);

  expect(result.notes).toEqual([note]);
  expect(result.counts).toEqual({ alert: 1, note: 1, warning: 1 });
  expect(input[0]).toBe(warning);
});

test('delivery failing is shown only once the run of failures is 10 minutes old', () => {
  const now = 10_000_000;
  expect(DELIVERY_FAILING_SHOWN_AFTER_MS).toBe(10 * 60_000);
  expect(deliveryFailingShown({ deliveryFailingSince: undefined, now })).toBeUndefined();
  expect(
    deliveryFailingShown({ deliveryFailingSince: now - DELIVERY_FAILING_SHOWN_AFTER_MS + 1, now }),
  ).toBeUndefined();
  expect(
    deliveryFailingShown({ deliveryFailingSince: now - DELIVERY_FAILING_SHOWN_AFTER_MS, now }),
  ).toBe(now - DELIVERY_FAILING_SHOWN_AFTER_MS);
});

test('Fleet verdict counts the same notes as Can wait, keeping other levels and excluding unpaired history', () => {
  const restarted: Attention = {
    checkedAt: 100,
    conditionId: 'restart',
    evidence: 'current',
    firstDetected: 100,
    kind: 'service_restarted',
    level: 'note',
    reason: 'Stopped once',
    service: undefined,
    subject: 'web',
    system: 'server-1',
    unpaired: false,
  };
  const items = [
    disk(),
    disk({ level: 'alert' }),
    disk({ level: 'note' }),
    restarted,
    { ...restarted, unpaired: true },
  ];
  expect(fleetAttention(items).counts).toEqual({ alert: 1, note: 1, warning: 1 });
  expect(canWaitRows(['server-1'], items)).toEqual([{ notes: ['Low disk /'], system: 'server-1' }]);
});
