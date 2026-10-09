import { expect, test } from 'bun:test';

import { defaultStateDir, resolveStateDir } from './state-dir.ts';

test('macOS keeps state under Application Support', () => {
  expect(defaultStateDir({ env: {}, home: '/Users/operator', platform: 'darwin' })).toBe(
    '/Users/operator/Library/Application Support/heimdall',
  );
});

test('Linux keeps state under XDG_STATE_HOME', () => {
  expect(
    defaultStateDir({
      env: { XDG_STATE_HOME: '/var/lib/x' },
      home: '/home/operator',
      platform: 'linux',
    }),
  ).toBe('/var/lib/x/heimdall');
});

test('Linux falls back to ~/.local/state without XDG_STATE_HOME', () => {
  expect(
    defaultStateDir({ env: { XDG_STATE_HOME: '' }, home: '/home/operator', platform: 'linux' }),
  ).toBe('/home/operator/.local/state/heimdall');
});

test('a state directory that is named wins over the default', () => {
  expect(resolveStateDir({ env: { HOME: '/home/operator' }, option: '/srv/state' })).toBe(
    '/srv/state',
  );
});

test('without one, the default is under the account home', () => {
  expect(
    resolveStateDir({ env: { HOME: '/home/operator' }, option: undefined, platform: 'linux' }),
  ).toBe('/home/operator/.local/state/heimdall');
});
