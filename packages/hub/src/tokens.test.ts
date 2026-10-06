import { expect, test } from 'bun:test';

import { TokenEntrySchema, tokenTable } from './tokens.ts';

test('a token entry names a System and its token', () => {
  expect(TokenEntrySchema.parse('laptop-1=s3cr=t')).toEqual({
    system: 'laptop-1',
    token: 's3cr=t',
  });
});

test.each([
  ['no separator', 'laptop-1'],
  ['an empty token', 'laptop-1='],
  ['a System outside Fleet names', 'LAPTOP_1=s3cret'],
  ['whitespace in the token, which HTTP would trim from the header', 'laptop-1=s3cret '],
])('a token entry with %s is invalid', (_, entry) => {
  expect(TokenEntrySchema.safeParse(entry).success).toBe(false);
});

test('the table answers the System a token belongs to', () => {
  const table = tokenTable([
    { system: 'server-1', token: 'a-token' },
    { system: 'laptop-1', token: 'm-token' },
  ]);

  expect(table.systemFor('m-token')).toBe('laptop-1');
  expect(table.systemFor('a-token')).toBe('server-1');
});

test('the table answers no System for an unknown token', () => {
  const table = tokenTable([{ system: 'server-1', token: 'a-token' }]);

  expect(table.systemFor('a-toke')).toBeUndefined();
  expect(table.systemFor('')).toBeUndefined();
});

test('a token shared by two Systems is refused', () => {
  expect(() =>
    tokenTable([
      { system: 'server-1', token: 'same' },
      { system: 'laptop-1', token: 'same' },
    ]),
  ).toThrow('server-1 and laptop-1 share a token');
});

test('a System with two tokens is refused', () => {
  expect(() =>
    tokenTable([
      { system: 'server-1', token: 'one' },
      { system: 'server-1', token: 'two' },
    ]),
  ).toThrow('server-1 has more than one token');
});
