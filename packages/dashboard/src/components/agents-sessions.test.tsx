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
import type { AgentsBreakdown, AgentsSession } from '../server/agents-overview-types.ts';
import { AgentsSessions } from './agents-sessions.tsx';

const renderSessions = async (
  sessions: AgentsSession[],
  picked?: string,
  by: AgentsBreakdown = 'project',
) => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => <AgentsSessions by={by} now={200} picked={picked} sessions={sessions} />,
    getParentRoute: () => root,
    path: '/agents',
    validateSearch: agentsSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/agents?range=7d&by=model&pick=heimdall'] }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
};

test('period Session rows link with every identity field and describe observed request activity', async () => {
  const html = await renderSessions([
    {
      activeRecently: true,
      branch: 'topic/agents',
      harness: 'codex',
      lastRequestAt: 180,
      models: ['m-a'],
      pricedCostUsd: 4,
      project: 'heimdall',
      requests: 3,
      sessionId: 'one',
      source: 'work',
      system: 'asgard',
      unpricedRequests: 1,
    },
    {
      activeRecently: false,
      branch: undefined,
      harness: 'aider',
      lastRequestAt: 160,
      models: [],
      pricedCostUsd: 0,
      project: undefined,
      requests: 1,
      sessionId: 'two',
      source: 'home',
      system: 'unpaired-system',
      unpricedRequests: 0,
    },
  ]);
  expect(html).toContain('href="/systems/asgard/sessions/codex/work/one"');
  expect(html).toContain('href="/systems/unpaired-system/sessions/aider/home/two"');
  expect(html).toContain('heimdall');
  expect(html).toContain('topic/agents');
  expect(html).toContain('Active recently');
  expect(html).toContain('Last request');
  expect(html.replace(/<[^>]+>/gu, '')).toContain('At least $4.00');
  expect(html).toContain('1 unpriced request');
  expect(html).toContain('aider Session two');
  expect(html).not.toContain('Running');
  expect(html).not.toContain('Ended');
});

test('a picked row shows a chip that clears the pick, and a pick with no Sessions shows the empty state', async () => {
  const html = await renderSessions([], 'heimdall');
  expect(html).toContain('Sessions in');
  expect(html).toMatch(/<a(?=[^>]*href="\/agents\?[^"]*")(?![^>]*pick=)[^>]*>heimdall/u);
  expect(html).toContain('No requests in this period.');
  const plain = await renderSessions([]);
  expect(plain).not.toContain('Sessions in');
  // The chip is as tall as the other controls.
  expect(html).toContain('min-h-11');
  expect(html).not.toContain('min-h-9');
});

test('the chip of a picked model reads Sessions using, and the other dimensions Sessions in', async () => {
  const model = await renderSessions([], 'big-model', 'model');
  expect(model).toContain('Sessions using');
  expect(model).not.toContain('Sessions in');
  expect(model).toContain('aria-label="Show all Sessions, not only those using big-model"');
  for (const by of ['project', 'system', 'harness'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one render per dimension.
    const html = await renderSessions([], 'x', by);
    expect(html).toContain('Sessions in');
    expect(html).not.toContain('Sessions using');
  }
});
