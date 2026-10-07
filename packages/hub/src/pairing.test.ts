import { expect, test } from 'bun:test';

import { CODE_ALPHABET, newCode, readCode, showCode } from './pairing.ts';

test('the code alphabet is Crockford base32: digits and letters without I, L, O, and U', () => {
  expect(CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
});

test('a new code is 8 characters of the code alphabet', () => {
  for (let i = 0; i < 100; i += 1) {
    expect(newCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/u);
  }
});

// Every byte value fills one code character. 256 is a multiple of 32, so when
// each byte value appears once, each character must appear exactly 8 times.
test('every random byte value maps to each character equally often', () => {
  let next = 0;
  const fill = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = next;
      next += 1;
    }
    return bytes;
  };
  const codes = Array.from({ length: 32 }, () => newCode(fill)).join('');

  const counts = new Map<string, number>();
  for (const char of codes) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  expect(codes).toHaveLength(256);
  expect([...counts.keys()].toSorted().join('')).toBe(CODE_ALPHABET);
  expect(new Set(counts.values())).toEqual(new Set([8]));
});

test('two new codes differ', () => {
  expect(newCode()).not.toBe(newCode());
});

test('a code is shown as two groups of four joined by a dash', () => {
  expect(showCode('7K3MQ9XA')).toBe('7K3M-Q9XA');
});

test.each([
  ['as shown', '7K3M-Q9XA'],
  ['without the dash', '7K3MQ9XA'],
  ['in lowercase', '7k3m-q9xa'],
  ['in mixed case without the dash', '7k3MQ9xa'],
  ['with surrounding whitespace', '  7K3M-Q9XA\n'],
])('a code typed %s reads as the code', (_, typed) => {
  expect(readCode(typed)).toBe('7K3MQ9XA');
});

test.each([
  ['too short', '7K3M-Q9X'],
  ['too long', '7K3M-Q9XAB'],
  ['a letter outside the alphabet', '7K3M-Q9XU'],
  ['a dash in the wrong place', '7K3-MQ9XA'],
  ['two dashes', '7K3M--Q9XA'],
  ['a space inside', '7K3M Q9XA'],
  ['a letter that only uppercases into the alphabet', '7K3M-Q9\u00DF'],
  ['a Kelvin sign in place of a K', '7\u212A3M-Q9XA'],
  ['empty', ''],
  ['not a string', 12_345_678],
  ['missing', undefined],
])('a code that is %s is malformed', (_, typed) => {
  expect(readCode(typed)).toBeUndefined();
});
