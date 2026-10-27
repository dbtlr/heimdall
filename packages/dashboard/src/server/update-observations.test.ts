import { expect, test } from 'bun:test';

import type { UpdateManager } from '@heimdall/schema';

import { parseUpdateObservations } from './update-observations.ts';

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
