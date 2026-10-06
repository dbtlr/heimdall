import { expect, test } from 'bun:test';

import { VitalsSampleSchema } from '@heimdall/schema';

import { hostProbe } from './host.ts';
import { createSampler } from './sampler.ts';

// The parsers are covered by fixtures; this proves the live readings on the
// platform running the tests fit the Report schema.
test('this host yields a sample the Report schema accepts', async () => {
  const sample = await createSampler(hostProbe()).sample();

  expect(VitalsSampleSchema.parse(sample)).toEqual(sample);
  expect(sample.memory.usedBytes).toBeGreaterThan(0);
  expect(sample.disks.length).toBeGreaterThan(0);
});
