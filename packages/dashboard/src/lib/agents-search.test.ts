import { expect, test } from 'bun:test';

import { agentsSearch, parseAgentsInput } from './agents-search.ts';

test('Agents defaults to Today and waits for a valid browser zone before reading totals', () => {
  expect(agentsSearch({})).toEqual({
    by: 'project',
    pick: undefined,
    range: 'today',
    zone: undefined,
  });
  expect(agentsSearch({ range: '24h', zone: 'not/a-zone' })).toEqual({
    by: 'project',
    pick: undefined,
    range: 'today',
    zone: undefined,
  });
  expect(agentsSearch({ range: '30d', zone: 'Europe/Berlin' })).toEqual({
    by: 'project',
    pick: undefined,
    range: '30d',
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
  expect(agentsSearch({ pick: 'x'.repeat(512) }).pick).toBe('x'.repeat(512));
  expect(agentsSearch({ pick: 'x'.repeat(513) }).pick).toBeUndefined();
  expect(agentsSearch({ pick: '' }).pick).toBeUndefined();
  expect(agentsSearch({ pick: 7 }).pick).toBeUndefined();
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
