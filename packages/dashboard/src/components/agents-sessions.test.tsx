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
import type {
  AgentsBreakdown,
  AgentsSession,
  SessionSort,
  SortDirection,
} from '../server/agents-overview-types.ts';
import { AgentsSessions } from './agents-sessions.tsx';

const renderSessions = async (
  sessions: AgentsSession[],
  {
    by = 'project',
    dir = 'desc',
    now = 200,
    page = 1,
    pick,
    sort = 'started',
    total = sessions.length,
  }: {
    by?: AgentsBreakdown;
    dir?: SortDirection;
    now?: number;
    page?: number;
    pick?: string;
    sort?: SessionSort;
    total?: number;
  } = {},
) => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => (
      <AgentsSessions
        by={by}
        dir={dir}
        now={now}
        pick={pick}
        rangeText="in 30 days"
        sort={sort}
        table={{ page, sessions, total }}
      />
    ),
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
  const html = await renderSessions(
    [
      {
        branch: 'topic/agents',
        firstRequestAt: 100,
        harness: 'codex',
        lastRequestAt: 999_900,
        models: ['m-a'],
        pricedCostUsd: 4,
        project: 'heimdall',
        requests: 3,
        sessionId: 'one',
        source: 'work',
        system: 'server-1',
        topModel: 'm-a',
        unpricedRequests: 1,
      },
      {
        branch: undefined,
        firstRequestAt: 160,
        harness: 'aider',
        lastRequestAt: 160,
        models: [],
        pricedCostUsd: 0,
        project: undefined,
        requests: 1,
        sessionId: 'two',
        source: 'home',
        system: 'unpaired-system',
        topModel: undefined,
        unpricedRequests: 0,
      },
    ],
    { now: 1_000_000 },
  );
  expect(html).toContain('href="/systems/server-1/sessions/codex/work/one"');
  expect(html).toContain('href="/systems/unpaired-system/sessions/aider/home/two"');
  expect(html).toContain('heimdall');
  expect(html).toContain('topic/agents');
  expect(html).toContain('Running');
  expect(html.replace(/<[^>]+>/gu, '')).toContain('At least $4.00');
  expect(html).toContain('1 unpriced request');
  expect(html).toContain('aider Session two');
});

test('a picked row shows a chip that clears the pick, and a pick with no Sessions shows the empty state', async () => {
  const html = await renderSessions([], { pick: 'heimdall' });
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
  const model = await renderSessions([], { by: 'model', pick: 'big-model' });
  expect(model).toContain('Sessions using');
  expect(model).not.toContain('Sessions in');
  expect(model).toContain('aria-label="Show all Sessions, not only those using big-model"');
  for (const by of ['project', 'system', 'harness'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one render per dimension.
    const html = await renderSessions([], { by, pick: 'x' });
    expect(html).toContain('Sessions in');
    expect(html).not.toContain('Sessions using');
  }
});

const at = (lastRequestAt: number): AgentsSession => ({
  branch: undefined,
  firstRequestAt: lastRequestAt,
  harness: 'codex',
  lastRequestAt,
  models: [],
  pricedCostUsd: 0,
  project: undefined,
  requests: 1,
  sessionId: String(lastRequestAt),
  source: 'work',
  system: 'server-1',
  topModel: undefined,
  unpricedRequests: 0,
});

test('a Session is running for 5 minutes after its latest request, as on Home, on its row', async () => {
  const now = 10 * 60_000;
  const edge = at(now - 5 * 60_000);
  const past = at(now - 5 * 60_000 - 1);

  const rows = await renderSessions([edge], { now });
  expect(rows).toContain('>Running<');
  expect(await renderSessions([past], { now })).not.toContain('Running');
});

test('each column header links to its sort, flipping the direction of the sorted column and dropping the page, which is the first again', async () => {
  const html = await renderSessions([at(1)], { dir: 'desc', page: 3, sort: 'cost', total: 80 });
  const header = (label: string) =>
    new RegExp(`<th[^>]*>\\s*<a[^>]*href="([^"]*)"[^>]*>${label}`, 'u').exec(html)?.[1] ?? '';
  // The sorted column flips; another starts at its first direction, which needs no dir.
  expect(header('Cost')).toMatch(/dir=asc/u);
  expect(header('Cost')).toMatch(/sort=cost/u);
  expect(header('Cost')).not.toContain('page=');
  expect(header('System')).not.toContain('dir=');
  expect(header('System')).toMatch(/sort=system/u);
  expect(header('Requests')).not.toContain('dir=');
  expect(html).toContain('aria-sort="descending"');
});

test('the pager states which Sessions a page shows and links its neighbours', async () => {
  const shown = Array.from({ length: 25 }, (_, index) => at(index));
  const html = await renderSessions(shown, { page: 2, total: 96 });
  expect(html.replace(/<[^>]+>/gu, '')).toContain('26–50 of 96 Sessions in 30 days');
  expect(html).toMatch(/<a[^>]*href="[^"]*"[^>]*>‹ Prev/u);
  // Page 1 is no page param.
  expect(/<a[^>]*href="([^"]*)"[^>]*>‹ Prev/u.exec(html)?.[1]).not.toContain('page=');
  expect(html).toMatch(/<a[^>]*href="[^"]*page=3[^"]*"[^>]*>Next ›/u);
  expect(html).toMatch(/aria-current="page"[^>]*>2</u);
  const only = await renderSessions([at(1)], { total: 1 });
  expect(only.replace(/<[^>]+>/gu, '')).toContain('1–1 of 1 Session in 30 days');
  expect(only).not.toContain('Next ›');
});
