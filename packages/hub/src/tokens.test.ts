import { expect, test } from 'bun:test';

import { TokenEntrySchema, tokenTable } from './tokens.ts';

test('a token entry names a System and its token', () => {
  expect(TokenEntrySchema.parse('db-mbp=s3cr=t')).toEqual({ system: 'db-mbp', token: 's3cr=t' });
});

test.each([
  ['no separator', 'db-mbp'],
  ['an empty token', 'db-mbp='],
  ['a System outside Fleet names', 'DB_MBP=s3cret'],
  ['whitespace in the token, which HTTP would trim from the header', 'db-mbp=s3cret '],
])('a token entry with %s is invalid', (_, entry) => {
  expect(TokenEntrySchema.safeParse(entry).success).toBe(false);
});

test('the table answers the System a token belongs to', () => {
  const table = tokenTable([
    { system: 'asgard', token: 'a-token' },
    { system: 'db-mbp', token: 'm-token' },
  ]);

  expect(table.systemFor('m-token')).toBe('db-mbp');
  expect(table.systemFor('a-token')).toBe('asgard');
});

test('the table answers no System for an unknown token', () => {
  const table = tokenTable([{ system: 'asgard', token: 'a-token' }]);

  expect(table.systemFor('a-toke')).toBeUndefined();
  expect(table.systemFor('')).toBeUndefined();
});

test('a token shared by two Systems is refused', () => {
  expect(() =>
    tokenTable([
      { system: 'asgard', token: 'same' },
      { system: 'db-mbp', token: 'same' },
    ]),
  ).toThrow('asgard and db-mbp share a token');
});

test('a System with two tokens is refused', () => {
  expect(() =>
    tokenTable([
      { system: 'asgard', token: 'one' },
      { system: 'asgard', token: 'two' },
    ]),
  ).toThrow('asgard has more than one token');
});
