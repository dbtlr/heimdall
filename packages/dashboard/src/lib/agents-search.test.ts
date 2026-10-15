import { expect, test } from 'bun:test';

import { agentsSearch, parseAgentsInput } from './agents-search.ts';

test('Agents defaults to Today and waits for a valid browser zone before reading totals', () => {
  expect(agentsSearch({})).toEqual({ range: 'today', zone: undefined });
  expect(agentsSearch({ range: '24h', zone: 'not/a-zone' })).toEqual({
    range: 'today',
    zone: undefined,
  });
  expect(agentsSearch({ range: '30d', zone: 'Europe/Berlin' })).toEqual({
    range: '30d',
    zone: 'Europe/Berlin',
  });
});

test('the server boundary rejects invalid periods and zones instead of reading different totals', () => {
  expect(parseAgentsInput({ range: '7d', timeZone: 'Europe/Berlin' })).toEqual({
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
