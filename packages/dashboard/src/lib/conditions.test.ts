import { expect, test } from 'bun:test';

import { KIND_NAMES, SEVERITY } from './conditions.ts';

test.each([
  ['system_stale', 'critical', 'Stale System'],
  ['service_down', 'critical', 'Service down'],
  ['low_disk', 'critical', 'Low disk'],
  ['job_failing', 'serious', 'Job failing'],
  ['reports_rejected', 'serious', 'Reports rejected'],
  ['job_overdue', 'warning', 'Job overdue'],
  ['drift', 'warning', 'Drift'],
] as const)('%s is %s and reads %s', (kind, severity, name) => {
  expect(SEVERITY[kind]).toBe(severity);
  expect(KIND_NAMES[kind]).toBe(name);
});
