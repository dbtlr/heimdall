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

import type { AgentsSession } from '../server/agents-overview-types.ts';
import { AgentsSessions } from './agents-sessions.tsx';

const renderSessions = async (sessions: AgentsSession[]) => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => <AgentsSessions now={200} sessions={sessions} />,
    getParentRoute: () => root,
    path: '/agents',
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/agents'] }),
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
