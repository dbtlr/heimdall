import { expect, mock, test } from 'bun:test';

import type { FleetGlance, FleetOverview, Lane } from '../server/fleet-overview-types.ts';
import { isOverview, readFleetPage } from './fleet-data.ts';

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

const overview: FleetOverview = { ...glance, from: 0, range: '24h', to: 1 };

test('a page below lg reads only the glance, with just unpaired', async () => {
  const readOverview = mock(async (_args: { data: unknown }) => overview);
  const readGlance = mock(async (_args: { data: unknown }) => glance);
  const data = await readFleetPage(
    { range: '7d', unpaired: true },
    { glance: readGlance, overview: readOverview, wide: false },
  );
  expect(data).toBe(glance);
  expect(readOverview).not.toHaveBeenCalled();
  expect(readGlance.mock.calls).toEqual([[{ data: { unpaired: true } }]]);
});

test('a page at lg reads only the overview, with range and unpaired', async () => {
  const readOverview = mock(async (_args: { data: unknown }) => overview);
  const readGlance = mock(async (_args: { data: unknown }) => glance);
  const data = await readFleetPage(
    { range: '7d', unpaired: false },
    { glance: readGlance, overview: readOverview, wide: true },
  );
  expect(data).toBe(overview);
  expect(readGlance).not.toHaveBeenCalled();
  expect(readOverview.mock.calls).toEqual([[{ data: { range: '7d', unpaired: false } }]]);
});
