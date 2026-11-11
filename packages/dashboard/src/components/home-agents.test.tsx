import { describe, expect, test } from 'bun:test';

import type { AgentsSession } from '../server/agents-overview-types.ts';
import type { HomeAgents } from '../server/home-types.ts';
import { AgentsCard } from './home-agents.tsx';
import { renderRouted } from './render-routed.tsx';

const NOW = Date.UTC(2026, 9, 6, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const session = (sessionId: string, over: Partial<AgentsSession> = {}): AgentsSession => ({
  branch: 'feat/tombstones',
  firstRequestAt: NOW - 130 * MINUTE,
  harness: 'claude-code',
  lastRequestAt: NOW - MINUTE,
  models: ['claude-opus-5-5'],
  pricedCostUsd: 43.36,
  project: 'norn',
  requests: 40,
  sessionId,
  source: 'claude-code',
  system: 'server-1',
  topModel: 'claude-opus-5-5',
  unpricedRequests: 0,
  ...over,
});

const agents = (over: Partial<HomeAgents> = {}): HomeAgents => ({
  days: [212, 340, 298, 181, 402, 371, 148.3].map((pricedCostUsd, index) => ({
    pricedCostUsd,
    requests: 10,
    start: NOW - (6 - index) * DAY,
    unpricedRequests: 0,
  })),
  latestRequestAt: undefined,
  running: [session('one')],
  timeZone: 'UTC',
  today: { pricedCostUsd: 148.3, requests: 10, unpricedRequests: 0 },
  usualByNow: 190.4,
  ...over,
});

const render = (read: HomeAgents | undefined) =>
  renderRouted(<AgentsCard agents={read} now={NOW} />);

const text = (html: string) => html.replaceAll(/<[^>]+>/gu, '');

describe('AgentsCard', () => {
  test("shows today's cost, what is usually spent by now, and seven bars with today's in the selection color", async () => {
    const html = await render(agents());

    expect(text(html)).toContain('$148.30today · usually $190 by now');
    expect(html.match(/flex-1 rounded-t/gu)).toHaveLength(7);
    expect(html.match(/bg-select/gu)).toHaveLength(1);
    expect(html.match(/bg-plot/gu)).toHaveLength(6);
    expect(html).toContain('last 7 days');
    expect(html).toContain('href="/agents"');
    expect(text(html)).toContain('Spend and Sessions');
  });

  test("keeps today's bar in the selection color before today has spent anything", async () => {
    const html = await render(
      agents({
        days: [212, 0, 298, 181, 402, 371, 0].map((pricedCostUsd, index) => ({
          pricedCostUsd,
          requests: pricedCostUsd === 0 ? 0 : 10,
          start: NOW - (6 - index) * DAY,
          unpricedRequests: 0,
        })),
        today: { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
      }),
    );

    expect(html.match(/bg-select/gu)).toHaveLength(1);
    expect(html.match(/bg-border/gu)).toHaveLength(1);
    expect(html.match(/bg-plot/gu)).toHaveLength(5);
  });

  test('marks a cost with an unpriced request "At least" and leaves out the usual when there is none', async () => {
    const html = await render(
      agents({
        today: { pricedCostUsd: 2, requests: 3, unpricedRequests: 1 },
        usualByNow: undefined,
      }),
    );

    expect(text(html)).toContain('At least$2.00');
    expect(html).not.toContain('usually');
  });

  test('a running Session links to its page with its project, branch, cost, System, Harness, model, and age', async () => {
    const html = await render(agents());

    expect(html).toContain('href="/systems/server-1/sessions/claude-code/claude-code/one"');
    expect(text(html)).toContain('norn feat/tombstones$43.36');
    expect(text(html)).toContain('server-1 · Claude Code · Opus 5.5 · 2 h 10 min');
  });

  test('lists 5 running Sessions and links the rest as "+N more" to the Agents page', async () => {
    const running = Array.from({ length: 7 }, (_, index) =>
      session(`s${String(index)}`, { lastRequestAt: NOW - index * 1000 }),
    );

    const html = await render(agents({ running }));

    expect(html.match(/sessions\/claude-code\/claude-code\/s/gu)).toHaveLength(5);
    expect(html).toContain('/s4"');
    expect(html).not.toContain('/s5"');
    expect(text(html)).toContain('+2 more');
  });

  test('with none running, says so and when the latest Session ended', async () => {
    const html = await render(agents({ latestRequestAt: NOW - 66 * MINUTE, running: [] }));

    expect(text(html)).toContain('No Session is running. The latest ended 1 h 6 min ago.');
  });

  test('with no Session ever recorded, says so instead of a cost', async () => {
    const html = await render(agents({ latestRequestAt: undefined, running: [] }));

    expect(text(html)).toContain('No agent Session has been recorded.');
    expect(html).not.toContain('$');
  });
});
