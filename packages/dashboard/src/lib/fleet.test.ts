import { expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import { fleetAttention, fleetVerdict, isAsleep } from './fleet.ts';

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

test('the worst open level names the Systems that need action, even when evidence is old', () => {
  expect(
    fleetVerdict([disk({ evidence: 'old', level: 'alert' }), disk({ system: 'laptop-1' })]),
  ).toBe('server-1 needs you now');
  expect(fleetVerdict([disk(), disk({ system: 'laptop-1' })])).toBe('2 Systems need you this week');
  expect(fleetVerdict([disk({ level: 'note' }), disk({ level: 'alert', unpaired: true })])).toBe(
    'No Conditions need action',
  );
});

test('sleep is a freshness fact independent of any open Condition', () => {
  expect(isAsleep({ lastSeenAt: 0, sleeps: true }, 120_001)).toBe(true);
  expect(isAsleep({ lastSeenAt: 0, sleeps: true }, 120_000)).toBe(false);
  expect(isAsleep({ lastSeenAt: 0, sleeps: false }, 120_001)).toBe(false);
  expect(isAsleep({ lastSeenAt: undefined, sleeps: true }, 120_001)).toBe(false);
});

test('Fleet orders stored levels before freshness and excludes unpaired history from its verdict', () => {
  const warning = disk();
  const oldAlert = disk({ evidence: 'old', firstDetected: 1, level: 'alert' });
  const note = disk({ level: 'note' });
  const unknown: Attention = {
    checkedAt: undefined,
    evidence: 'unknown',
    firstDetected: 90,
    kind: 'checks_missing',
    set: 'checks',
    subject: '',
    system: 'server-1',
    unpaired: false,
  };
  const input = [warning, note, unknown, oldAlert, disk({ level: 'alert', unpaired: true })];

  const result = fleetAttention(input);

  expect(result.needsYou).toEqual([oldAlert, warning]);
  expect(result.notes).toEqual([note]);
  expect(result.evidence).toEqual([unknown]);
  expect(result.counts).toEqual({ alert: 1, note: 1, warning: 1 });
  expect(input[0]).toBe(warning);
});
