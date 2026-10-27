import { expect, test } from 'bun:test';

import { installsOf } from './service-installs.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 200 * DAY;

test('the first known version is not a change', () => {
  expect(installsOf([{ at: NOW - DAY, version: '1.0' }], NOW)).toEqual([]);
});

test('a change between known versions names the version it replaced, newest first', () => {
  const rows = [
    { at: NOW - 3 * DAY, version: '1.0' },
    { at: NOW - 2 * DAY, version: '1.1' },
    { at: NOW - DAY, version: '1.2' },
  ];
  expect(installsOf(rows, NOW)).toEqual([
    { at: NOW - DAY, version: '1.2', was: '1.1' },
    { at: NOW - 2 * DAY, version: '1.1', was: '1.0' },
  ]);
});

test('an unknown between two rows of the same version emits nothing', () => {
  const rows = [
    { at: NOW - 3 * DAY, version: '1.0' },
    { at: NOW - 2 * DAY, version: null },
    { at: NOW - DAY, version: '1.0' },
  ];
  expect(installsOf(rows, NOW)).toEqual([]);
});

test('an unknown between two different versions emits one change', () => {
  const rows = [
    { at: NOW - 3 * DAY, version: '1.0' },
    { at: NOW - 2 * DAY, version: null },
    { at: NOW - DAY, version: '2.0' },
  ];
  expect(installsOf(rows, NOW)).toEqual([{ at: NOW - DAY, version: '2.0', was: '1.0' }]);
});

test('rows that repeat a version, as an upstream-only change does, emit nothing', () => {
  const rows = [
    { at: NOW - 3 * DAY, version: '1.0' },
    { at: NOW - 2 * DAY, version: '1.0' },
  ];
  expect(installsOf(rows, NOW)).toEqual([]);
});

test('a change before the window is left out, but still names what the next one replaced', () => {
  const rows = [
    { at: NOW - 150 * DAY, version: '1.0' },
    { at: NOW - 120 * DAY, version: '1.1' },
    { at: NOW - DAY, version: '1.2' },
  ];
  expect(installsOf(rows, NOW)).toEqual([{ at: NOW - DAY, version: '1.2', was: '1.1' }]);
});
