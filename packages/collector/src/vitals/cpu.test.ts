import { expect, test } from 'bun:test';

import { cpuBusyPercent } from './cpu.ts';

const core = (busy: number, idle: number) => ({ idle, irq: 0, nice: 0, sys: 0, user: busy });

test('busy percent averages every core over the interval', () => {
  const before = [core(100, 900), core(200, 800)];
  // Core one spent 50 of 100 ticks busy, core two 10 of 100.
  const after = [core(150, 950), core(210, 890)];

  expect(cpuBusyPercent(before, after)).toBe(30);
});

test('user, nice, sys, and irq all count as busy', () => {
  const before = [{ idle: 0, irq: 0, nice: 0, sys: 0, user: 0 }];
  const after = [{ idle: 60, irq: 10, nice: 10, sys: 10, user: 10 }];

  expect(cpuBusyPercent(before, after)).toBe(40);
});

test('an interval with no ticks reads as idle', () => {
  expect(cpuBusyPercent([core(5, 5)], [core(5, 5)])).toBe(0);
});
