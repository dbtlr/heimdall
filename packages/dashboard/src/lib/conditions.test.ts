import { expect, test } from 'bun:test';

import { conditionSubject, KIND_NAMES } from './conditions.ts';

test.each([
  ['system_stale', 'Stale System'],
  ['service_down', 'Service down'],
  ['low_disk', 'Low disk'],
  ['job_failing', 'Job failing'],
  ['reports_rejected', 'Reports rejected'],
  ['job_overdue', 'Job overdue'],
  ['drift', 'Drift'],
  ['pending_update', 'Pending update'],
  ['reboot_required', 'Reboot required'],
] as const)('%s reads %s', (kind, name) => {
  expect(KIND_NAMES[kind]).toBe(name);
});

test('pending updates display the package and manager instead of their identity', () => {
  expect(conditionSubject({ kind: 'pending_update', subject: '["apt","system","openssl"]' })).toBe(
    'openssl (apt, system)',
  );
  expect(conditionSubject({ kind: 'pending_update', subject: 'bad' })).toBe('Unknown package');
});
