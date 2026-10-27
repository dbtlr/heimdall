import { expect, test } from 'bun:test';

import { conditionSubject } from './condition-names.ts';

test('a clock skew subject names whose clock is wrong, and an own clock has none', () => {
  expect(conditionSubject({ kind: 'clock_skew', subject: '' })).toBe('');
  expect(conditionSubject({ kind: 'clock_skew', subject: 'hub' })).toBe("Hub's clock");
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
