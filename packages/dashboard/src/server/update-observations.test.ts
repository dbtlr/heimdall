import { expect, test } from 'bun:test';

import type { UpdateManager } from '@heimdall/schema';

import { parseUpdateObservations, pendingPackageOf } from './update-observations.ts';

const valid: UpdateManager = {
  installation: 'default',
  manager: 'apt',
  observedAt: 1000,
  result: { kind: 'available', metadataAt: 900, updates: [] },
};

test('keeps valid observations and drops one a package-manager read would trip on', () => {
  expect(
    parseUpdateObservations([valid, { installation: 'default', manager: 'apt', observedAt: 1000 }]),
  ).toEqual([valid]);
});

test('a stored pending update that does not parse keeps its package, with what it would change unknown', () => {
  const since = new Date(5000);
  expect(
    pendingPackageOf({
      name: 'git:amd64',
      pending_update: { name: 'git:amd64' },
      security_since: since,
    }),
  ).toEqual({
    available: null,
    installed: null,
    name: 'git:amd64',
    security: null,
    securitySince: 5000,
  });
  expect(
    pendingPackageOf({
      name: 'git:amd64',
      pending_update: { available: '2', installed: '1', name: 'git:amd64', security: true },
      security_since: null,
    }),
  ).toEqual({
    available: '2',
    installed: '1',
    name: 'git:amd64',
    security: true,
    securitySince: null,
  });
});
