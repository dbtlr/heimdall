import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { AgentsOverview } from '../server/agents-overview-types.ts';
import { AgentsSummary } from './agents-summary.tsx';

const overview: AgentsOverview = {
  from: 100,
  now: 200,
  range: 'today',
  sessions: [
    {
      activeRecently: true,
      branch: 'main',
      harness: 'codex',
      lastRequestAt: 180,
      pricedCostUsd: 4,
      project: 'heimdall',
      requests: 3,
      sessionId: 'one',
      source: 'default',
      system: 'asgard',
      unpricedRequests: 1,
    },
    {
      activeRecently: false,
      branch: undefined,
      harness: 'claude-code',
      lastRequestAt: 160,
      pricedCostUsd: 8,
      project: undefined,
      requests: 2,
      sessionId: 'two',
      source: 'default',
      system: 'asgard',
      unpricedRequests: 0,
    },
  ],
  timeZone: 'UTC',
  totals: { pricedCostUsd: 12, requests: 5, unpricedRequests: 1 },
};

test('Agents shows lower bounds wherever unpriced requests affect a period total', () => {
  const html = renderToStaticMarkup(<AgentsSummary overview={overview} />);
  expect(html).toContain('$12.00');
  expect(html).toContain('At least');
  expect(html).toContain('2 Sessions on 1 System');
  expect(html).toContain('1 request has no list price');
  expect(html).toContain('Claude Code');
  expect(html).toContain('$8.00');
  expect(html).toContain('Codex');
  expect(html).toContain('At least $4.00');
  expect(html).toContain('Priced request cost by Harness');
});

test('Agents keeps zero priced cost distinct from requests with no list price', () => {
  const html = renderToStaticMarkup(
    <AgentsSummary
      overview={{
        ...overview,
        sessions: overview.sessions.map((session) => ({ ...session, pricedCostUsd: 0 })),
        totals: { pricedCostUsd: 0, requests: 5, unpricedRequests: 1 },
      }}
    />,
  );
  expect(html).toContain('$0.00');
  expect(html).toContain('At least $0.00');
  expect(html).not.toContain('NaN');
  expect(html).not.toContain('Infinity');
  const empty = renderToStaticMarkup(
    <AgentsSummary
      overview={{
        ...overview,
        sessions: [],
        totals: { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
      }}
    />,
  );
  expect(empty).toContain('0 Sessions on 0 Systems');
  expect(empty).not.toContain('At least');
});
