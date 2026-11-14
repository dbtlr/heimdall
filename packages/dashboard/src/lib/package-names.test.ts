import { expect, test } from 'bun:test';

import { ownArchitecture, packageLabel } from './package-names.ts';

test('Homebrew drops the formula prefix and marks a cask', () => {
  expect(packageLabel('formula:git', undefined)).toEqual({ cask: false, label: 'git' });
  expect(packageLabel('cask:firefox', undefined)).toEqual({ cask: true, label: 'firefox' });
});

test("APT drops the architecture only when it is the System's own", () => {
  expect(packageLabel('openssl:amd64', 'amd64')).toEqual({ cask: false, label: 'openssl' });
  expect(packageLabel('libc6:i386', 'amd64')).toEqual({ cask: false, label: 'libc6:i386' });
  expect(packageLabel('openssl:amd64', undefined)).toEqual({ cask: false, label: 'openssl:amd64' });
});

test('a name without a prefix or architecture reads as it is', () => {
  expect(packageLabel('git', 'amd64')).toEqual({ cask: false, label: 'git' });
});

test("the System's own architecture is the commonest among its package names", () => {
  expect(ownArchitecture(['a:amd64', 'b:amd64', 'c:i386', 'plain'])).toBe('amd64');
  expect(ownArchitecture(['formula:git', 'plain'])).toBeUndefined();
});
