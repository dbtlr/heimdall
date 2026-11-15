import { expect, test } from 'bun:test';

import { breakdownTotals } from '../lib/agents-breakdown.ts';
import type { AgentsSession, PeriodOverview } from '../server/agents-overview-types.ts';
import type { ProjectView } from '../server/project-view.ts';
import { ProjectDossier, ProjectHeader } from './project-dossier.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const DAY = 86_400_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 6, 12);

const session = (sessionId: string, overrides: Partial<AgentsSession> = {}): AgentsSession => ({
  branch: 'main',
  firstRequestAt: NOW - 3_600_000,
  harness: 'claude-code',
  lastRequestAt: NOW - 3_000_000,
  models: ['big-model'],
  pricedCostUsd: 2,
  project: 'notes-app',
  requests: 4,
  sessionId,
  source: 'claude-code',
  system: 'server-1',
  topModel: 'big-model',
  unpricedRequests: 0,
  ...overrides,
});

const SESSIONS = Array.from({ length: 8 }, (_, index) =>
  session(`s${String(index)}`, { firstRequestAt: NOW - (index + 1) * 3_600_000 }),
);

const overview = (overrides: Partial<PeriodOverview> = {}): PeriodOverview => ({
  breakdown: breakdownTotals(SESSIONS, [
    { model: 'big-model', pricedCostUsd: 12, requests: 20, unpricedRequests: 0 },
    { model: 'small-model', pricedCostUsd: 4, requests: 12, unpricedRequests: 0 },
  ]),
  chart: {
    buckets: Array.from({ length: 7 }, (_, index) => ({
      end: NOW - (6 - index) * DAY + DAY / 2,
      start: NOW - (6 - index) * DAY - DAY / 2,
    })),
    cells: [2, 5, 6].map((bucket) => ({
      bucket,
      harness: 'claude-code',
      model: 'big-model',
      pricedCostUsd: bucket,
      project: 'notes-app',
      system: 'server-1',
      unpricedRequests: 0,
    })),
    unit: 'day',
  },
  from: NOW - 7 * DAY,
  now: NOW,
  range: '7d',
  running: [],
  sessionCount: SESSIONS.length,
  systemCount: 1,
  table: { page: 1, sessions: SESSIONS, total: SESSIONS.length },
  timeZone: 'UTC',
  totals: { pricedCostUsd: 14, requests: 32, unpricedRequests: 0 },
  usualByNow: undefined,
  ...overrides,
});

const lane = (sessionId: string, start: number, end: number, system = 'server-1') => ({
  end: NOW + end * MINUTE,
  harness: 'claude-code',
  sessionId,
  source: 'claude-code',
  start: NOW + start * MINUTE,
  system,
});

const view = (overrides: Partial<ProjectView> = {}): ProjectView => ({
  activeMs: 61 * 3_600_000,
  branches: ['main', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((name, index) => ({
    name,
    sessions: 10 - index,
  })),
  cpuSeconds: 3600,
  firstSessionAt: NOW - 30 * DAY,
  lanes: [lane('s0', -60, -50), lane('s1', -57, -45), lane('s2', -20, -10, 'laptop-1')],
  lastRequestAt: NOW - 40_000,
  name: 'notes-app',
  overview: overview(),
  peakRssBytes: 3 * 1024 ** 3,
  repository: true,
  subagents: 12,
  systems: ['devbox-1', 'laptop-1', 'server-1'],
  tail: SESSIONS.slice(0, 5).map((row, index) => ({ session: row, subagents: index })),
  toolCount: 40,
  tools: Array.from({ length: 30 }, (_, index) => ({
    calls: 100 - index,
    kind: 'tool',
    mcpServer: null,
    name: `tool-${String(index)}`,
    skill: null,
  })),
  ...overrides,
});

const ROUTES = [
  '/agents',
  '/projects/$name',
  '/systems/$name',
  '/systems/$name/sessions/$harness/$source/$sessionId',
];

const dossier = (value: ProjectView) =>
  renderRouted(<ProjectDossier view={value} />, {
    path: '/projects/notes-app',
    routePaths: ROUTES,
  });

const header = (value: ProjectView, timeZone: string | undefined) =>
  renderRouted(<ProjectHeader range="7d" timeZone={timeZone} view={value} />, {
    path: '/projects/notes-app',
    routePaths: ROUTES,
  });

const text = (html: string) => html.replaceAll(/<[^>]*>/gu, '');

test('the header leads with Agents, then the name, the range picker, and where the project lives', async () => {
  const html = await header(view(), 'UTC');
  const links = linksIn(html);
  expect(
    links.filter((link) => link.href === '/agents?range=7d').map((link) => link.label),
  ).toEqual(['‹ Agents', 'Agents']);
  expect(html.indexOf('Agents</a>')).toBeLessThan(html.indexOf('<h1'));
  expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('Agents period'));
  expect(text(html)).toContain(
    'Git repository on devbox-1, laptop-1, and server-1 · first Session 6 Sept',
  );
  // Nothing runs, so no badge, and no "0 running".
  expect(text(html)).not.toContain('running');
});

test('a running Session shows a badge by the name, and a folder with no repository says so', async () => {
  const running = overview({ running: [session('s0')] });
  const html = await header(
    view({ overview: running, repository: false, systems: ['laptop-1'] }),
    'UTC',
  );
  expect(text(html)).toContain('notes-app1 running');
  expect(text(html)).toContain('Folder with no recorded repository, on laptop-1 ·');
  expect(text(html)).not.toContain('Git repository');
});

test('the meta line waits for the viewer’s time zone', async () => {
  const html = await header(view(), undefined);
  expect(text(html)).not.toContain('first Session');
});

test('the cost tile gives the daily average and a sparkline, and names unpriced requests only when there are some', async () => {
  const priced = text(await dossier(view()));
  expect(priced).toContain('7 days · $2.00 a day');
  expect(priced).not.toContain('unpriced');
  const html = await dossier(
    view({
      overview: overview({ totals: { pricedCostUsd: 14, requests: 32, unpricedRequests: 3 } }),
    }),
  );
  expect(text(html)).toContain('7 days · $2.00 a day · 3 unpriced');
  expect(html).toContain('<polyline');
});

test('phone tiles carry short labels and notes', async () => {
  const html = await dossier(view());
  for (const short of ['Cost · 7 d', 'Process CPU', 'peak 3.0 GiB', '12 subagents']) {
    expect(html).toContain(`<span class="sm:hidden">${short}</span>`);
  }
});

test('the chart key sits with its bars, ahead of the System lanes', async () => {
  const html = await dossier(view());
  const key = html.indexOf('aria-label="Keys of the chart"');
  expect(key).toBeGreaterThan(-1);
  expect(key).toBeLessThan(html.indexOf('role="img"'));
  expect(html).not.toContain('order-last');
});

test('overlapping Sessions stack into rows of one lane, each block a 24 px tap target on phones', async () => {
  const html = await dossier(view());
  const blocks = [...html.matchAll(/<a [^>]*data-lane-row="(\d)"[^>]*>/gu)];
  expect(blocks.map(([, row]) => row)).toEqual(['0', '0', '1']);
  for (const [block] of blocks) {
    expect(block).toContain('max-sm:before:h-6');
    expect(block).toContain('max-sm:before:w-[max(100%,1.5rem)]');
  }
});

test('models, tools, and branches draw proportional bars and fold past five rows', async () => {
  const html = await dossier(view());
  expect(text(html)).toContain('25 more');
  expect(text(html)).toContain('2 more');
  expect(text(html)).toContain('10 names with fewer calls not listed.');
  expect(html).toContain('style="width:100%"');
  expect(html).toContain('style="width:33.33333333333333%"');
});

test('the Sessions tail shows five without the project per row and links to all of them on Agents', async () => {
  const html = await dossier(view());
  const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
  expect([...table.matchAll(/<th [^>]*>([^<]*)<\/th>/gu)].map(([, label]) => label)).toEqual([
    'Started',
    'System',
    'Harness',
    'Branch',
    'Model',
    'Subagents',
    'Duration',
    'Requests',
    'Cost',
  ]);
  expect(table.match(/<tr /gu)).toHaveLength(6);
  expect(table).not.toContain('notes-app');
  expect(linksIn(html).find((link) => link.label === 'All 8 Sessions ›')?.href).toBe(
    '/agents?by=project&pick=notes-app&range=7d',
  );
});
