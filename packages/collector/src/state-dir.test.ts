import { expect, test } from 'bun:test';

import { defaultStateDir } from './state-dir.ts';

test('macOS keeps state under Application Support', () => {
  expect(defaultStateDir({ env: {}, home: '/Users/drew', platform: 'darwin' })).toBe(
    '/Users/drew/Library/Application Support/heimdall',
  );
});

test('Linux keeps state under XDG_STATE_HOME', () => {
  expect(
    defaultStateDir({
      env: { XDG_STATE_HOME: '/var/lib/x' },
      home: '/home/drew',
      platform: 'linux',
    }),
  ).toBe('/var/lib/x/heimdall');
});

test('Linux falls back to ~/.local/state without XDG_STATE_HOME', () => {
  expect(
    defaultStateDir({ env: { XDG_STATE_HOME: '' }, home: '/home/drew', platform: 'linux' }),
  ).toBe('/home/drew/.local/state/heimdall');
});
