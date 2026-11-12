import { expect, test } from 'bun:test';

import { nextSort, pageButtons, pageCount, pageRange, sortSearch } from './agents-sessions.ts';

test('a column header sorts words from A and times and amounts from the most, and a second pick flips it', () => {
  expect(nextSort({ dir: 'desc', sort: 'started' }, 'project')).toEqual({
    dir: 'asc',
    sort: 'project',
  });
  expect(nextSort({ dir: 'asc', sort: 'project' }, 'cost')).toEqual({ dir: 'desc', sort: 'cost' });
  expect(nextSort({ dir: 'desc', sort: 'cost' }, 'cost')).toEqual({ dir: 'asc', sort: 'cost' });
  expect(nextSort({ dir: 'asc', sort: 'cost' }, 'cost')).toEqual({ dir: 'desc', sort: 'cost' });
});

test('pages count 25 Sessions each, never fewer than one, and a page names the Sessions it shows', () => {
  expect([0, 1, 25, 26, 96].map(pageCount)).toEqual([1, 1, 1, 2, 4]);
  expect(pageRange(1, 25)).toEqual({ first: 1, last: 25 });
  expect(pageRange(4, 21)).toEqual({ first: 76, last: 96 });
});

test('the pager lists the ends, the neighbours of the current page, and an ellipsis only over a gap of two or more', () => {
  expect(pageButtons(1, 1)).toEqual([1]);
  expect(pageButtons(1, 13)).toEqual([1, 2, 3, 'gap', 13]);
  expect(pageButtons(6, 13)).toEqual([1, 'gap', 5, 6, 7, 'gap', 13]);
  expect(pageButtons(3, 8)).toEqual([1, 2, 3, 4, 'gap', 8]);
  expect(pageButtons(3, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(pageButtons(13, 13)).toEqual([1, 'gap', 11, 12, 13]);
  expect(pageButtons(2, 4)).toEqual([1, 2, 3, 4]);
});

test("an order is in the search only where it differs from newest first and from the column's first direction", () => {
  expect(sortSearch({ dir: 'desc', sort: 'started' })).toEqual({ dir: undefined, sort: undefined });
  expect(sortSearch({ dir: 'asc', sort: 'started' })).toEqual({ dir: 'asc', sort: undefined });
  expect(sortSearch({ dir: 'asc', sort: 'project' })).toEqual({ dir: undefined, sort: 'project' });
  expect(sortSearch({ dir: 'desc', sort: 'project' })).toEqual({ dir: 'desc', sort: 'project' });
});
