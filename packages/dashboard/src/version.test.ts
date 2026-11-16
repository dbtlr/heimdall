import { expect, test } from 'bun:test';

import { buildId, DASHBOARD_BUILD, DASHBOARD_VERSION } from './version.ts';

test('a build id names its release and the moment it was built', () => {
  expect(buildId('1.2.3', Date.UTC(2026, 10, 16))).toBe(
    `1.2.3+${Date.UTC(2026, 10, 16).toString(36)}`,
  );
});

test('outside a Vite build, the build is named by the release alone', () => {
  expect(DASHBOARD_BUILD).toBe(DASHBOARD_VERSION);
});
