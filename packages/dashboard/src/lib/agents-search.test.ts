import { expect, test } from 'bun:test';

import { agentsSearch, parseAgentsInput, sessionsQueryOf } from './agents-search.ts';

test('Agents defaults to Today and waits for a valid browser zone before reading totals', () => {
  expect(agentsSearch({})).toEqual({
    by: 'project',
    dir: undefined,
    page: undefined,
    pick: undefined,
    range: 'today',
    sort: undefined,
    zone: undefined,
  });
  expect(agentsSearch({ range: '24h', zone: 'not/a-zone' })).toEqual({
    by: 'project',
    dir: undefined,
    page: undefined,
    pick: undefined,
    range: 'today',
    sort: undefined,
    zone: undefined,
  });
  expect(agentsSearch({ range: '30d', zone: 'Europe/Berlin' })).toEqual({
    by: 'project',
    dir: undefined,
    page: undefined,
    pick: undefined,
    range: '30d',
    sort: undefined,
    zone: 'Europe/Berlin',
  });
});

test('the cost breakdown dimension falls back to project, and a pick must be a short string', () => {
  for (const by of ['project', 'system', 'model', 'harness'] as const) {
    expect(agentsSearch({ by }).by).toBe(by);
  }
  expect(agentsSearch({ by: 'branch' }).by).toBe('project');
  expect(agentsSearch({ by: ['model'] }).by).toBe('project');
  expect(agentsSearch({ pick: 'heimdall' }).pick).toBe('heimdall');
  expect(agentsSearch({ pick: 'x'.repeat(4096) }).pick).toBe('x'.repeat(4096));
  expect(agentsSearch({ pick: 'x'.repeat(4097) }).pick).toBeUndefined();
  // The empty key is the row for Sessions with no working directory or requests with no model.
  expect(agentsSearch({ pick: '' }).pick).toBe('');
  expect(agentsSearch({ pick: 7 }).pick).toBeUndefined();
});

test('a sorted page is a link: the search holds only a known column, a direction, and a page from 2', () => {
  expect(agentsSearch({ dir: 'asc', page: '3', sort: 'cost' })).toMatchObject({
    dir: 'asc',
    page: 3,
    sort: 'cost',
  });
  expect(agentsSearch({ dir: 'up', page: 2, sort: 'name' })).toMatchObject({
    dir: undefined,
    page: 2,
    sort: undefined,
  });
  // Newest first and page 1 are what the table does without a search.
  expect(agentsSearch({ page: 1, sort: 'started' })).toMatchObject({
    page: undefined,
    sort: undefined,
  });
  for (const page of [0, -1, 1.5, 'abc', 1_000_001, null]) {
    expect(agentsSearch({ page }).page).toBeUndefined();
  }
});

test('a page in the address is plain digits; any other spelling of a number is page 1', () => {
  expect(agentsSearch({ page: '12' }).page).toBe(12);
  for (const page of ['0x2', '2e0', ' 3 ', '+2', '2.0', '', '1000001']) {
    expect(agentsSearch({ page }).page).toBeUndefined();
  }
});

test('the server reads the query a search describes, with newest first on page 1 as the default', () => {
  expect(sessionsQueryOf(agentsSearch({}))).toEqual({
    by: 'project',
    dir: 'desc',
    page: 1,
    pick: undefined,
    sort: 'started',
  });
  // A word column starts from A, and a direction in the search wins.
  expect(sessionsQueryOf(agentsSearch({ sort: 'project' })).dir).toBe('asc');
  expect(sessionsQueryOf(agentsSearch({ dir: 'desc', sort: 'project' })).dir).toBe('desc');
  expect(sessionsQueryOf(agentsSearch({ sort: 'cost' })).dir).toBe('desc');
  expect(sessionsQueryOf(agentsSearch({ dir: 'asc' }))).toMatchObject({
    dir: 'asc',
    sort: 'started',
  });
});

test('the server boundary rejects invalid periods and zones instead of reading different totals', () => {
  expect(parseAgentsInput({ range: '7d', timeZone: 'Europe/Berlin' })).toEqual({
    ...sessionsQueryOf(agentsSearch({})),
    range: '7d',
    timeZone: 'Europe/Berlin',
  });
  for (const input of [
    undefined,
    { range: '24h', timeZone: 'UTC' },
    { range: 'today' },
    { range: 'today', timeZone: 'not/a-zone' },
    { range: 'today', timeZone: '+03:00' },
    { range: 'today', timeZone: "UTC'; SELECT 1" },
  ]) {
    expect(() => parseAgentsInput(input)).toThrow('Invalid Agents period');
  }
});
