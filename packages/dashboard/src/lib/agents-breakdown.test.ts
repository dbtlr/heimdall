import { expect, test } from 'bun:test';

import type { AgentsOverview, AgentsSession } from '../server/agents-overview-types.ts';
import { breakdownRows, formatPercent } from './agents-breakdown.ts';

const session = (overrides: Partial<AgentsSession>): AgentsSession => ({
  branch: undefined,
  firstRequestAt: 50,
  harness: 'claude-code',
  lastRequestAt: 100,
  models: ['m-a'],
  pricedCostUsd: 1,
  project: 'heimdall',
  requests: 1,
  sessionId: 'one',
  source: 'default',
  system: 'server-1',
  topModel: 'm-a',
  unpricedRequests: 0,
  ...overrides,
});

const overviewOf = (
  sessions: AgentsSession[],
  models: AgentsOverview['models'] = [],
): AgentsOverview => ({
  chart: { buckets: [], cells: [], unit: 'day' },
  from: 0,
  models,
  now: 200,
  range: 'today',
  sessions,
  table: { page: 1, sessions, total: sessions.length },
  timeZone: 'UTC',
  today: { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
  totals: { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
  usualByNow: undefined,
});

test('rows group Sessions by project, System, or Harness, highest priced cost first and ties by name', () => {
  const overview = overviewOf([
    session({ pricedCostUsd: 2, project: 'zeta', sessionId: 'a', system: 'b-box' }),
    session({ pricedCostUsd: 2, project: 'alpha', sessionId: 'b', system: 'a-box' }),
    session({
      harness: 'codex',
      pricedCostUsd: 5,
      project: 'zeta',
      sessionId: 'c',
      system: 'a-box',
    }),
  ]);
  expect(breakdownRows(overview, 'project').map((row) => [row.name, row.pricedCostUsd])).toEqual([
    ['zeta', 7],
    ['alpha', 2],
  ]);
  expect(breakdownRows(overview, 'system').map((row) => [row.name, row.pricedCostUsd])).toEqual([
    ['a-box', 7],
    ['b-box', 2],
  ]);
  const harnesses = breakdownRows(overview, 'harness');
  expect(harnesses.map((row) => [row.key, row.name])).toEqual([
    ['codex', 'Codex'],
    ['claude-code', 'Claude Code'],
  ]);
  expect(harnesses.map((row) => row.color)).toEqual(['var(--chart-2)', 'var(--chart-1)']);
  const tied = breakdownRows(
    overviewOf([
      session({ pricedCostUsd: 3, project: 'b', sessionId: 'x' }),
      session({ pricedCostUsd: 3, project: 'a', sessionId: 'y' }),
    ]),
    'project',
  );
  expect(tied.map((row) => row.name)).toEqual(['a', 'b']);
});

test('a Session with no project groups under an empty key labelled No working directory, apart from a project of that name', () => {
  const rows = breakdownRows(
    overviewOf([
      session({ pricedCostUsd: 5, project: undefined, sessionId: 'none' }),
      session({ pricedCostUsd: 3, project: 'No working directory', sessionId: 'named' }),
    ]),
    'project',
  );
  expect(rows.map(({ key, name, pricedCostUsd }) => [key, name, pricedCostUsd])).toEqual([
    ['', 'No working directory', 5],
    ['No working directory', 'No working directory', 3],
  ]);
});

test('an empty model groups under an empty key labelled Unknown model, apart from a model of that name', () => {
  const rows = breakdownRows(
    overviewOf(
      [],
      [
        { model: '', pricedCostUsd: 5, requests: 1, unpricedRequests: 0 },
        { model: 'Unknown model', pricedCostUsd: 3, requests: 1, unpricedRequests: 0 },
      ],
    ),
    'model',
  );
  expect(rows.map(({ key, name, pricedCostUsd }) => [key, name, pricedCostUsd])).toEqual([
    ['', 'Unknown model', 5],
    ['Unknown model', 'Unknown model', 3],
  ]);
});

test('model rows come from the overview, not from Sessions', () => {
  const rows = breakdownRows(
    overviewOf(
      [session({})],
      [
        { model: 'small', pricedCostUsd: 1, requests: 2, unpricedRequests: 0 },
        { model: 'big', pricedCostUsd: 3, requests: 1, unpricedRequests: 0 },
      ],
    ),
    'model',
  );
  expect(rows.map((row) => [row.key, row.percent])).toEqual([
    ['big', 75],
    ['small', 25],
  ]);
});

test('only the top five rows of a dimension take series colors and the rest share a neutral one', () => {
  const sessions = Array.from({ length: 7 }, (_, index) =>
    session({
      pricedCostUsd: 10 - index,
      project: `p${String(index)}`,
      sessionId: `s${String(index)}`,
    }),
  );
  const rows = breakdownRows(overviewOf(sessions), 'project');
  expect(rows.map((row) => row.color)).toEqual([
    'var(--series-1)',
    'var(--series-2)',
    'var(--series-3)',
    'var(--series-4)',
    'var(--series-5)',
    'var(--chart-other)',
    'var(--chart-other)',
  ]);
});

test('unpriced rules: a lower bound for mixed rows, no list price and no percent for all-unpriced ones', () => {
  const rows = breakdownRows(
    overviewOf([
      session({
        pricedCostUsd: 6,
        project: 'mixed',
        requests: 4,
        sessionId: 'a',
        unpricedRequests: 1,
      }),
      session({ pricedCostUsd: 2, project: 'clean', requests: 2, sessionId: 'b' }),
      session({
        pricedCostUsd: 0,
        project: 'none',
        requests: 3,
        sessionId: 'c',
        unpricedRequests: 3,
      }),
    ]),
    'project',
  );
  expect(rows.map((row) => [row.name, row.pricing, row.percent])).toEqual([
    ['mixed', 'at-least', 75],
    ['clean', 'exact', 25],
    ['none', 'none', undefined],
  ]);
});

test('percent labels round and never show a nonzero share as 0%', () => {
  expect(formatPercent(41.4)).toBe('41%');
  expect(formatPercent(0.2)).toBe('<1%');
  expect(formatPercent(0)).toBe('0%');
  expect(formatPercent(undefined)).toBe('');
});

test('a period with no priced cost has zero percents, not NaN', () => {
  const rows = breakdownRows(overviewOf([session({ pricedCostUsd: 0 })]), 'project');
  expect(rows[0]?.percent).toBe(0);
});
