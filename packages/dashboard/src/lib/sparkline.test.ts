import { expect, test } from 'bun:test';

import { sparklinePath } from './sparkline.ts';

const size = { height: 30, width: 100 };

test('points become one polyline path across the time span, high values near the top', () => {
  const path = sparklinePath(
    [
      { t: 0, value: 0 },
      { t: 10, value: 50 },
      { t: 20, value: 100 },
    ],
    [],
    { ...size, ceiling: 100 },
  );
  expect(path).toBe('M0,29 L50,15 L100,1');
});

test('a gap between two points starts a new segment', () => {
  const path = sparklinePath(
    [
      { t: 0, value: 100 },
      { t: 10, value: 100 },
      { t: 30, value: 100 },
      { t: 40, value: 100 },
    ],
    [{ from: 15, to: 30 }],
    { ...size, ceiling: 100 },
  );
  expect(path).toBe('M0,1 L25,1 M75,1 L100,1');
});

test('a lone point still draws a mark', () => {
  expect(sparklinePath([{ t: 5, value: 100 }], [], { ...size, ceiling: 100 })).toBe('M50,1 L50,1');
});

test('no points give an empty path', () => {
  expect(sparklinePath([], [], size)).toBe('');
});

test('the x axis spans the given window, so a series that stops early leaves the right end empty', () => {
  const path = sparklinePath(
    [
      { t: 0, value: 100 },
      { t: 50, value: 100 },
    ],
    [],
    { ...size, ceiling: 100, from: 0, to: 100 },
  );
  expect(path).toBe('M0,1 L50,1');
});

test('points that start after the window start leave the left end empty', () => {
  const path = sparklinePath(
    [
      { t: 50, value: 100 },
      { t: 100, value: 100 },
    ],
    [],
    { ...size, ceiling: 100, from: 0, to: 100 },
  );
  expect(path).toBe('M50,1 L100,1');
});
