import { expect, test } from 'bun:test';

import { KIND_NAMES } from './conditions.ts';

test.each([
  ['system_stale', 'Stale System'],
  ['service_down', 'Service down'],
  ['low_disk', 'Low disk'],
  ['job_failing', 'Job failing'],
  ['reports_rejected', 'Reports rejected'],
  ['job_overdue', 'Job overdue'],
  ['drift', 'Drift'],
] as const)('%s reads %s', (kind, name) => {
  expect(KIND_NAMES[kind]).toBe(name);
});
