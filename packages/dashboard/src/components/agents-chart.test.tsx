import { expect, test } from 'bun:test';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { agentsSearch } from '../lib/agents-search.ts';
import type {
  AgentsBreakdown,
  AgentsOverview,
  AgentsSession,
  CostCell,
} from '../server/agents-overview-types.ts';
import { AgentsChart } from './agents-chart.tsx';
import { AgentsFigures } from './agents-headline.tsx';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12);

const cell = (overrides: Partial<CostCell>): CostCell => ({
  bucket: 2,
  harness: 'claude-code',
  model: 'big-model',
  pricedCostUsd: 8,
  project: 'heimdall',
  system: 'server-1',
  unpricedRequests: 0,
  ...overrides,
});

const session = (overrides: Partial<AgentsSession>): AgentsSession => ({
  branch: 'main',
  firstRequestAt: NOW - 3_600_000,
  harness: 'claude-code',
  lastRequestAt: NOW - 60_000,
  models: ['big-model'],
  pricedCostUsd: 12,
  project: 'heimdall',
  requests: 2,
  sessionId: 'one',
  source: 'default',
  system: 'server-1',
  topModel: 'big-model',
  unpricedRequests: 0,
  ...overrides,
});

const overview: AgentsOverview = {
  chart: {
    buckets: [0, 1, 2].map((index) => ({
      end: NOW - (2 - index) * DAY + DAY / 2,
      start: NOW - (2 - index) * DAY - DAY / 2,
    })),
    cells: [
      cell({ bucket: 0, pricedCostUsd: 4 }),
      cell({ harness: 'codex', model: 'small-model', pricedCostUsd: 4, project: 'fleet' }),
      cell({ pricedCostUsd: 8 }),
    ],
    unit: 'day',
  },
  from: NOW - 7 * DAY,
  models: [
    { model: 'big-model', pricedCostUsd: 12, requests: 3, unpricedRequests: 0 },
    { model: 'small-model', pricedCostUsd: 4, requests: 2, unpricedRequests: 0 },
  ],
  now: NOW,
  range: '7d',
  sessions: [
    session({}),
    session({
      harness: 'codex',
      lastRequestAt: NOW - 3_600_000,
      pricedCostUsd: 4,
      project: 'fleet',
      sessionId: 'two',
      unpricedRequests: 0,
    }),
  ],
  timeZone: 'UTC',
  today: { pricedCostUsd: 8, requests: 2, unpricedRequests: 0 },
  totals: { pricedCostUsd: 16, requests: 4, unpricedRequests: 1 },
  usualByNow: 11.2,
};

const render = async (
  element: ReactNode,
  entry = '/agents?range=7d&by=harness&zone=Europe%2FBerlin',
) => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => element,
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

const chart = (by: AgentsBreakdown, pick?: string, value = overview) =>
  render(<AgentsChart by={by} overview={value} pick={pick} />);

test('the legend lists each key with its total and share, and the switch keeps range and zone', async () => {
  const html = await chart('harness');
  expect(html).toContain('Cost per day, by Harness');
  expect(html).toContain('Claude Code');
  expect(html).toContain('$12.00');
  expect(html).toContain('75%');
  expect(html).toContain('Codex');
  expect(html).toContain('25%');
  expect(html).toMatch(/<a(?=[^>]*aria-current=)[^>]*>Harness<\/a>/u);
  expect(html).toContain('range=7d');
  expect(html).toContain('zone=Europe%2FBerlin');
});

test('picking a key dims the other keys, and the picked key links to clearing the pick', async () => {
  const picked = await chart('harness', 'codex');
  expect(picked.match(/opacity:0\.25/gu)).toHaveLength(2);
  expect(picked.match(/opacity:1/gu)).toHaveLength(1);
  expect(picked).toMatch(/<a(?=[^>]*aria-current)(?![^>]*pick=)[^>]*title="Codex"/u);
  expect(picked).toMatch(/<a(?![^>]*aria-current)[^>]*title="Claude Code"[^>]*pick=claude-code/u);
  expect(await chart('harness')).not.toContain('opacity:0.25');
});

test('the usual-by-now mark sits on the last day bar only, and the hourly view has none', async () => {
  const days = await chart('project');
  expect(days.match(/data-usual-by-now/gu)).toHaveLength(1);
  expect(days).toContain('dashed: usual by now');
  const hours = await chart('project', undefined, {
    ...overview,
    chart: { ...overview.chart, unit: 'hour' },
    range: 'today',
  });
  expect(hours).not.toContain('data-usual-by-now');
  expect(hours).toContain('Cost per hour');
});

test('keys past the fifth fold into a count, and a picked one among them opens the legend', async () => {
  const many: AgentsOverview = {
    ...overview,
    chart: {
      ...overview.chart,
      cells: Array.from({ length: 7 }, (_, index) =>
        cell({ pricedCostUsd: 10 - index, project: `project-${String(index)}` }),
      ),
    },
    sessions: Array.from({ length: 7 }, (_, index) =>
      session({
        pricedCostUsd: 10 - index,
        project: `project-${String(index)}`,
        sessionId: String(index),
      }),
    ),
  };
  const folded = await chart('project', undefined, many);
  expect(folded).toContain('project-4');
  expect(folded).not.toContain('project-5');
  expect(folded).toContain('2 more');
  const open = await chart('project', 'project-6', many);
  expect(open).toContain('project-6');
  expect(open).not.toContain('2 more');
});

test('a note says unpriced requests may change the shares, only when there are some', async () => {
  const note = 'Unpriced requests may change these shares and this order.';
  expect(
    await chart('model', undefined, {
      ...overview,
      models: [{ model: 'mystery', pricedCostUsd: 0, requests: 1, unpricedRequests: 1 }],
    }),
  ).toContain(note);
  expect(await chart('harness')).not.toContain(note);
});

test('with nothing priced the chart still draws a scale, without NaN', async () => {
  const html = await chart('project', undefined, {
    ...overview,
    chart: { ...overview.chart, cells: [] },
    models: [],
    sessions: [],
  });
  expect(html).toContain('$0');
  expect(html).not.toContain('NaN');
  expect(html).not.toContain('Infinity');
});

test('the figures put Today against usual by now, the period total with at least, and running Sessions', async () => {
  const html = await render(<AgentsFigures overview={overview} />);
  expect(html).toContain('$8.00');
  expect(html).toContain('usual by now $11');
  expect(html).toContain('7 days');
  expect(html).toContain('$16.00');
  expect(html).toContain('at least · 1 unpriced');
  expect(html).toContain('Running now');
  expect(html).toContain('>1<');
});

test('the Today range shows one cost figure, and a Session is running for 5 minutes after its latest request', async () => {
  const today = await render(
    <AgentsFigures overview={{ ...overview, range: 'today', usualByNow: undefined }} />,
  );
  expect(today).not.toContain('7 days');
  expect(today).toContain('no usual by now yet');
  const edge = session({ lastRequestAt: NOW - 5 * 60_000 });
  const past = session({ lastRequestAt: NOW - 5 * 60_000 - 1, sessionId: 'past' });
  const running = await render(
    <AgentsFigures overview={{ ...overview, sessions: [edge, past] }} />,
  );
  expect(running).toContain('>1<');
});
