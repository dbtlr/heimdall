import { expect, test } from 'bun:test';

import { sessionSearch } from './session-search.ts';

test('the page opens on the Timeline with the whole Trace and nothing selected', () => {
  expect(sessionSearch({})).toEqual({
    agent: undefined,
    filter: 'everything',
    lane: undefined,
    request: undefined,
    tab: 'timeline',
  });
});

test('reads the tab, filter, agent, lane, and request asked for', () => {
  expect(
    sessionSearch({ agent: 'main', filter: 'tools', lane: 'a7', request: 'msg_1', tab: 'trace' }),
  ).toEqual({ agent: 'main', filter: 'tools', lane: 'a7', request: 'msg_1', tab: 'trace' });
});

test('drops a tab or filter it does not know, and empty or non-text ids', () => {
  expect(sessionSearch({ agent: '', filter: 'all', request: 7, tab: 'graphs' })).toEqual({
    agent: undefined,
    filter: 'everything',
    lane: undefined,
    request: undefined,
    tab: 'timeline',
  });
});
