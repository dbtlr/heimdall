import { expect, test } from 'bun:test';

import { scaleTicks, yPercent } from './chart-scale.ts';

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
