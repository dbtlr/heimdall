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
  ['clock_skew', 'Clock skew'],
] as const)('%s reads %s', (kind, name) => {
  expect(KIND_NAMES[kind]).toBe(name);
});

test('pending updates display the package source, and older occurrences the package too', () => {
  expect(
    conditionSubject({ kind: 'pending_update', subject: '["homebrew","/opt/homebrew"]' }),
  ).toBe('Homebrew (/opt/homebrew)');
  expect(conditionSubject({ kind: 'pending_update', subject: '["apt","system"]' })).toBe(
    'APT (system)',
  );
  expect(conditionSubject({ kind: 'pending_update', subject: '["macos","system"]' })).toBe(
    'macOS (system)',
  );
  expect(conditionSubject({ kind: 'pending_update', subject: '["apt","system","openssl"]' })).toBe(
    'openssl (APT, system)',
  );
  expect(conditionSubject({ kind: 'pending_update', subject: 'bad' })).toBe('Unknown package');
});
