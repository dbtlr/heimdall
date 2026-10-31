import { expect, test } from 'bun:test';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';

import { agentsSearch } from '../lib/agents-search.ts';
import type { AgentsBreakdown, AgentsOverview } from '../server/agents-overview-types.ts';
import { AgentsSummary } from './agents-summary.tsx';

const overview: AgentsOverview = {
  from: 100,
  models: [
    { model: 'big-model', pricedCostUsd: 8, requests: 2, unpricedRequests: 0 },
    { model: 'mystery', pricedCostUsd: 0, requests: 1, unpricedRequests: 1 },
    { model: 'small-model', pricedCostUsd: 4, requests: 2, unpricedRequests: 0 },
  ],
  now: 200,
  range: 'today',
  sessions: [
    {
      activeRecently: true,
      branch: 'main',
      harness: 'codex',
      lastRequestAt: 180,
      models: ['mystery', 'small-model'],
      pricedCostUsd: 4,
      project: 'heimdall',
      requests: 3,
      sessionId: 'one',
      source: 'default',
      system: 'server-1',
      unpricedRequests: 1,
    },
    {
      activeRecently: false,
      branch: undefined,
      harness: 'claude-code',
      lastRequestAt: 160,
      models: ['big-model'],
      pricedCostUsd: 8,
      project: undefined,
      requests: 2,
      sessionId: 'two',
      source: 'default',
      system: 'server-1',
      unpricedRequests: 0,
    },
  ],
  timeZone: 'UTC',
  totals: { pricedCostUsd: 12, requests: 5, unpricedRequests: 1 },
};

const renderSummary = async ({
  by = 'harness',
  entry = `/agents?range=7d&by=${by}&zone=Europe%2FBerlin`,
  pick,
  value = overview,
}: {
  by?: AgentsBreakdown;
  entry?: string;
  pick?: string;
  value?: AgentsOverview;
} = {}) => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => <AgentsSummary by={by} overview={value} pick={pick} />,
    getParentRoute: () => root,
    path: '/agents',
    validateSearch: agentsSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [entry] }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
};

test('Agents shows lower bounds wherever unpriced requests affect a period total', async () => {
  const html = await renderSummary();
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

test('Agents keeps zero priced cost distinct from requests with no list price', async () => {
  const html = await renderSummary({
    value: {
      ...overview,
      sessions: overview.sessions.map((session) => ({ ...session, pricedCostUsd: 0 })),
      totals: { pricedCostUsd: 0, requests: 5, unpricedRequests: 1 },
    },
  });
  expect(html).toContain('$0.00');
  expect(html).toContain('At least $0.00');
  expect(html).not.toContain('NaN');
  expect(html).not.toContain('Infinity');
  const empty = await renderSummary({
    value: {
      ...overview,
      models: [],
      sessions: [],
      totals: { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
    },
  });
  expect(empty).toContain('0 Sessions on 0 Systems');
  expect(empty).not.toContain('At least');
});

test('the switch offers four dimensions, marks the current one, and keeps range and zone', async () => {
  const html = await renderSummary({ by: 'system' });
  expect(html).toContain('aria-label="Break down by"');
  for (const by of ['project', 'system', 'model', 'harness']) {
    expect(html).toContain(`by=${by}&amp;`);
  }
  for (const label of ['Project', 'System', 'Model', 'Harness']) {
    expect(html).toContain(`>${label}</a>`);
  }
  expect(html.match(/aria-current=/gu)).toHaveLength(1);
  expect(html).toMatch(/<a(?=[^>]*aria-current=)[^>]*>System<\/a>/u);
  expect(html).toContain('range=7d');
  expect(html).toContain('zone=Europe%2FBerlin');
  expect(html).toContain('Priced request cost by System');
});

test('switching clears a pick and tapping a row sets or clears it', async () => {
  const html = await renderSummary({
    by: 'project',
    entry: '/agents?range=7d&by=project&pick=heimdall',
    pick: 'heimdall',
  });
  expect(html).toMatch(/<a(?=[^>]*href="[^"]*by=model)(?![^>]*pick=)[^>]*>Model<\/a>/u);
  // The picked row is outlined and links to the list without its pick.
  expect(html).toMatch(/<a(?=[^>]*outline-chart-1)(?![^>]*pick=)[^>]*title="heimdall"/u);
  // The row of Sessions with no working directory picks the empty key.
  expect(html).toMatch(/<a(?![^>]*outline-chart-1)[^>]*pick=(?:&amp;|")[^>]*>/u);
});

// The line under the picked row, from its count to its link to the Sessions list.
const jumpLine = /<div[^>]*lg:hidden[^>]*>.*?<\/div>/u;

test('below the wide layout, the picked row counts its Sessions and links down to them', async () => {
  const system = await renderSummary({
    by: 'system',
    entry: '/agents?range=7d&by=system&pick=server-1',
    pick: 'server-1',
  });
  const line = jumpLine.exec(system)?.[0];
  expect(line).toContain('2 Sessions');
  // The link keeps the pick and lands on the list's heading.
  expect(line).toMatch(/href="[^"]*pick=server-1[^"]*#agents-sessions-heading"/u);
  const model = await renderSummary({
    by: 'model',
    entry: '/agents?range=7d&by=model&pick=small-model',
    pick: 'small-model',
  });
  expect(jumpLine.exec(model)?.[0]).toContain('1 Session<');
  expect(await renderSummary({ by: 'system' })).not.toMatch(jumpLine);
});

test('model rows use per-request totals, and a model with no list price shows no cost or percent', async () => {
  const html = await renderSummary({ by: 'model' });
  expect(html.indexOf('big-model')).toBeLessThan(html.indexOf('small-model'));
  expect(html).toContain('No list price');
  expect(html.indexOf('small-model')).toBeLessThan(html.indexOf('mystery'));
  expect(html).toContain('67%');
  expect(html).not.toContain('0%');
});

const nineProjects = (): AgentsOverview => ({
  ...overview,
  sessions: Array.from({ length: 9 }, (_, index) => ({
    ...overview.sessions[1]!,
    pricedCostUsd: 20 - index,
    project: `project-${String(index)}`,
    sessionId: `s${String(index)}`,
  })),
});

test('more than eight rows fold the rest into a count', async () => {
  const html = await renderSummary({ by: 'project', value: nineProjects() });
  expect(html).toContain('project-7');
  expect(html).not.toContain('project-8');
  expect(html).toContain('1 more');
});

test('a picked row past the fold opens the list, and one at the fold boundary does not', async () => {
  // Row index 8 is the first folded row, and 7 the last shown one.
  const first = await renderSummary({ by: 'project', pick: 'project-8', value: nineProjects() });
  expect(first).toContain('project-8');
  expect(first).not.toContain('1 more');
  const last = await renderSummary({ by: 'project', pick: 'project-7', value: nineProjects() });
  expect(last).not.toContain('project-8');
  expect(last).toContain('1 more');
});

test('a note under the list says unpriced requests may change the shares and the order', async () => {
  const note = 'Unpriced requests may change these shares and this order.';
  expect(await renderSummary({ by: 'harness' })).toContain(note);
  expect(await renderSummary({ by: 'model' })).toContain(note);
  const priced = await renderSummary({
    value: {
      ...overview,
      models: overview.models.filter((one) => one.unpricedRequests === 0),
      sessions: [{ ...overview.sessions[0]!, unpricedRequests: 0 }, overview.sessions[1]!],
    },
  });
  expect(priced).not.toContain('Unpriced requests may change');
});
