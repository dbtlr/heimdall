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
import type { AgentsSession } from '../server/agents-overview-types.ts';
import { AgentsSessions } from './agents-sessions.tsx';

const renderSessions = async (sessions: AgentsSession[], picked?: string) => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => <AgentsSessions now={200} picked={picked} sessions={sessions} />,
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
});
