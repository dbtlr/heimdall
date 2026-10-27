import { expect, test } from 'bun:test';

import type { AgentsOverview, AgentsSession } from '../server/agents-overview-types.ts';
import { barSegments, breakdownRows, formatPercent, sessionsIn } from './agents-breakdown.ts';

const session = (overrides: Partial<AgentsSession>): AgentsSession => ({
  activeRecently: false,
  branch: undefined,
  harness: 'claude-code',
  lastRequestAt: 100,
  models: ['m-a'],
  pricedCostUsd: 1,
  project: 'heimdall',
  requests: 1,
  sessionId: 'one',
  source: 'default',
  system: 'asgard',
  unpricedRequests: 0,
  ...overrides,
});

const overviewOf = (
  sessions: AgentsSession[],
  models: AgentsOverview['models'] = [],
): AgentsOverview => ({
  from: 0,
  models,
  now: 200,
  range: 'today',
  sessions,
  timeZone: 'UTC',
  totals: { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
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
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
    'var(--chart-other)',
    'var(--chart-other)',
  ]);
  const segments = barSegments(rows);
  expect(segments).toHaveLength(6);
  expect(segments.at(-1)?.color).toBe('var(--chart-other)');
  expect(segments.at(-1)?.percent).toBeCloseTo(((5 + 4) / 49) * 100);
  expect(segments.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(100);
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
  expect(barSegments(rows).map((segment) => segment.percent)).toEqual([75, 25]);
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
  expect(barSegments(rows)).toEqual([]);
});

test('a pick keeps the Sessions in that project, on that System, of that Harness, or that used that model', () => {
  const sessions = [
    session({ harness: 'codex', models: ['m-a', 'm-b'], project: undefined, sessionId: 'a' }),
    session({ models: ['m-b'], project: 'heimdall', sessionId: 'b', system: 'laptop' }),
    session({ models: [''], project: 'other', sessionId: 'c', system: 'desk' }),
  ];
  const ids = (by: Parameters<typeof sessionsIn>[1], key: string) =>
    sessionsIn(sessions, by, key).map((one) => one.sessionId);
  expect(ids('project', 'heimdall')).toEqual(['b']);
  expect(ids('project', '')).toEqual(['a']);
  expect(ids('project', 'No working directory')).toEqual([]);
  expect(ids('system', 'laptop')).toEqual(['b']);
  expect(ids('model', 'm-b')).toEqual(['a', 'b']);
  expect(ids('model', 'm-a')).toEqual(['a']);
  expect(ids('model', '')).toEqual(['c']);
  expect(ids('harness', 'codex')).toEqual(['a']);
  expect(ids('harness', 'nothing')).toEqual([]);
});
