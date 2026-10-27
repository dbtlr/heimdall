import { expect, test } from 'bun:test';

import type { FleetGlance, FleetOverview, Lane } from '../server/fleet-overview-types.ts';
import { isOverview } from './fleet-data.ts';

const glance: FleetGlance<Lane> = {
  attention: [],
  deliveryFailingSince: undefined,
  lanes: [],
  now: 1,
  unpairedCount: 0,
  unpairedLanes: [],
};

test('only data with a range is an overview', () => {
  const overview: FleetOverview = { ...glance, from: 0, range: '24h', to: 1 };
  expect(isOverview(glance)).toBe(false);
  expect(isOverview(overview)).toBe(true);
});
