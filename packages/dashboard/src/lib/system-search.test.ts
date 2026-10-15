import { expect, test } from 'bun:test';

import { systemSearch } from './system-search.ts';

test('a System opens on Now, while an existing sample link opens Vitals', () => {
  expect(systemSearch({})).toEqual({ at: undefined, range: '12h', tab: 'now' });
  expect(systemSearch({ at: 1234, range: '24h' })).toEqual({
    at: 1234,
    range: '24h',
    tab: 'vitals',
  });
});

test('System tabs validate shared links without dropping their range or sample', () => {
  expect(systemSearch({ at: 1234, range: '7d', tab: 'sessions' })).toEqual({
    at: 1234,
    range: '7d',
    tab: 'sessions',
  });
  expect(systemSearch({ at: 'bad', range: 'bad', tab: 'bad' })).toEqual({
    at: undefined,
    range: '12h',
    tab: 'now',
  });
});
