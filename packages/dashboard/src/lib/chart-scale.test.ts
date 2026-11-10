import { expect, test } from 'bun:test';

import { niceDomain, scaleTicks, yPercent } from './chart-scale.ts';

test('a percentage scale labels 100 at the top, 50 halfway, and 0 at the bottom', () => {
  expect(scaleTicks([0, 100])).toEqual([
    { value: 100, y: 0 },
    { value: 50, y: 50 },
    { value: 0, y: 100 },
  ]);
});

test('a scale that starts above zero labels its own bottom and middle', () => {
  expect(scaleTicks([80, 100]).map(({ value }) => value)).toEqual([100, 90, 80]);
});

test('a limit sits as far down the plot as its value is below the top of the scale', () => {
  expect(yPercent(90, [0, 100])).toBe(10);
  expect(yPercent(90, [80, 100])).toBe(50);
  expect(yPercent(1.5, [0, 6])).toBe(75);
});

test('a value outside the scale stays on the plot edge', () => {
  expect(yPercent(120, [0, 100])).toBe(0);
  expect(yPercent(-5, [0, 100])).toBe(100);
});

test('a nice scale widens to whole steps, so its middle is a whole step too', () => {
  expect(niceDomain([0, 31.3], 1)).toEqual([0, 32]);
  expect(niceDomain([0, 1.37], 0.1)).toEqual([0, 1.4]);
  expect(niceDomain([0, 1], 0.1)).toEqual([0, 1]);
  expect(niceDomain([0, 1.2], 0.1)).toEqual([0, 1.2]);
  expect(niceDomain([0.3, 7.8], 0.1)).toEqual([0.2, 7.8]);
});

test('every label of a nice scale is a whole step', () => {
  for (const [high, step] of [
    [31.3, 1],
    [9.95, 0.1],
    [1.37, 0.1],
    [0.06, 0.1],
  ] as const) {
    for (const { value } of scaleTicks(niceDomain([0, high], step))) {
      expect(Number((value / step).toFixed(9)) % 1).toBe(0);
    }
  }
});
