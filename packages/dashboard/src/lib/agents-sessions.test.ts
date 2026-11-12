import { expect, test } from 'bun:test';

import { SESSION_SORTS } from '../server/agents-overview-types.ts';
import type { AgentsSession, SessionsQuery } from '../server/agents-overview-types.ts';
import {
  nextSort,
  pageButtons,
  pageCount,
  pageRange,
  sessionsPage,
  sortSearch,
} from './agents-sessions.ts';

test('a column header sorts words from A and times and amounts from the most, and a second pick flips it', () => {
  expect(nextSort({ dir: 'desc', sort: 'started' }, 'project')).toEqual({
    dir: 'asc',
    sort: 'project',
  });
  expect(nextSort({ dir: 'asc', sort: 'project' }, 'cost')).toEqual({ dir: 'desc', sort: 'cost' });
  expect(nextSort({ dir: 'desc', sort: 'cost' }, 'cost')).toEqual({ dir: 'asc', sort: 'cost' });
  expect(nextSort({ dir: 'asc', sort: 'cost' }, 'cost')).toEqual({ dir: 'desc', sort: 'cost' });
});

test('pages count 25 Sessions each, never fewer than one, and a page names the Sessions it shows', () => {
  expect([0, 1, 25, 26, 96].map(pageCount)).toEqual([1, 1, 1, 2, 4]);
  expect(pageRange(1, 25)).toEqual({ first: 1, last: 25 });
  expect(pageRange(4, 21)).toEqual({ first: 76, last: 96 });
});

test('the pager lists the ends, the neighbours of the current page, and an ellipsis only over a gap of two or more', () => {
  expect(pageButtons(1, 1)).toEqual([1]);
  expect(pageButtons(1, 13)).toEqual([1, 2, 3, 'gap', 13]);
  expect(pageButtons(6, 13)).toEqual([1, 'gap', 5, 6, 7, 'gap', 13]);
  expect(pageButtons(3, 8)).toEqual([1, 2, 3, 4, 'gap', 8]);
  expect(pageButtons(3, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(pageButtons(13, 13)).toEqual([1, 'gap', 11, 12, 13]);
  expect(pageButtons(2, 4)).toEqual([1, 2, 3, 4]);
});

test("an order is in the search only where it differs from newest first and from the column's first direction", () => {
  expect(sortSearch({ dir: 'desc', sort: 'started' })).toEqual({ dir: undefined, sort: undefined });
  expect(sortSearch({ dir: 'asc', sort: 'started' })).toEqual({ dir: 'asc', sort: undefined });
  expect(sortSearch({ dir: 'asc', sort: 'project' })).toEqual({ dir: undefined, sort: 'project' });
  expect(sortSearch({ dir: 'desc', sort: 'project' })).toEqual({ dir: 'desc', sort: 'project' });
});

const NOW = 100 * 3_600_000;
const HOUR = 3_600_000;

const session = (overrides: Partial<AgentsSession>): AgentsSession => ({
  branch: undefined,
  firstRequestAt: NOW - 3 * HOUR,
  harness: 'claude-code',
  lastRequestAt: NOW - 2 * HOUR,
  models: ['m-a'],
  pricedCostUsd: 1,
  project: 'heimdall',
  requests: 1,
  sessionId: 'one',
  source: 'default',
  system: 'server-1',
  topModel: 'm-a',
  unpricedRequests: 0,
  ...overrides,
});

const query = (overrides: Partial<SessionsQuery>): SessionsQuery => ({
  by: 'project',
  dir: 'desc',
  page: 1,
  pick: undefined,
  sort: 'started',
  ...overrides,
});

const idsOf = (sessions: readonly AgentsSession[]) =>
  sessions.map((one) => `${one.system}/${one.harness}/${one.source}/${one.sessionId}`);

// Every page of a sort, in order.
const allPages = (sessions: readonly AgentsSession[], order: Partial<SessionsQuery>) => {
  const pages = pageCount(sessions.length);
  return Array.from({ length: pages }, (_, index) =>
    idsOf(sessionsPage(sessions, query({ ...order, page: index + 1 }), NOW).sessions),
  ).flat();
};

test('Sessions tied on a column keep one order whatever order they arrive in, so no page repeats or skips one', () => {
  // Tied on every column; only the identity tells them apart.
  const tied = Array.from({ length: 60 }, (_, index) =>
    session({
      harness: index % 2 === 0 ? 'codex' : 'claude-code',
      sessionId: `t${String(index).padStart(2, '0')}`,
      source: index % 3 === 0 ? 'work' : 'default',
      system: index % 4 === 0 ? 'laptop-1' : 'server-1',
    }),
  );
  const reversed = tied.toReversed();
  const shuffled = [
    ...tied.filter((_, index) => index % 3 === 1),
    ...tied.filter((_, index) => index % 3 !== 1).toReversed(),
  ];
  for (const sort of SESSION_SORTS) {
    for (const dir of ['asc', 'desc'] as const) {
      const rows = allPages(tied, { dir, sort });
      expect({ dir, sort, unique: new Set(rows).size }).toEqual({ dir, sort, unique: 60 });
      expect(allPages(reversed, { dir, sort })).toEqual(rows);
      expect(allPages(shuffled, { dir, sort })).toEqual(rows);
    }
  }
});

test('Duration sorts by how long a Session ran, and a Session with no project or no model sits last both ways', () => {
  const sessions = [
    session({ firstRequestAt: NOW - 30 * HOUR, lastRequestAt: NOW - 6 * HOUR, sessionId: 'long' }),
    session({ firstRequestAt: NOW - 5 * HOUR, lastRequestAt: NOW - 4 * HOUR, sessionId: 'short' }),
    session({
      firstRequestAt: NOW - 9 * HOUR,
      lastRequestAt: NOW - 7 * HOUR,
      project: undefined,
      sessionId: 'loose',
      topModel: undefined,
    }),
    session({
      firstRequestAt: NOW - 3 * HOUR,
      lastRequestAt: NOW - 2.5 * HOUR,
      project: 'Zeta',
      sessionId: 'upper',
      topModel: 'Z-model',
    }),
  ];
  const order = (sort: SessionsQuery['sort'], dir: SessionsQuery['dir']) =>
    sessionsPage(sessions, query({ dir, sort }), NOW).sessions.map((one) => one.sessionId);
  expect(order('duration', 'desc')).toEqual(['long', 'loose', 'short', 'upper']);
  expect(order('duration', 'asc')).toEqual(['upper', 'short', 'loose', 'long']);
  // Words sort by code unit, so Zeta comes before heimdall.
  expect(order('project', 'asc')).toEqual(['upper', 'long', 'short', 'loose']);
  expect(order('project', 'desc')).toEqual(['long', 'short', 'upper', 'loose']);
  expect(order('model', 'asc').at(-1)).toBe('loose');
  expect(order('model', 'desc').at(-1)).toBe('loose');
});

test('a Session whose only requests had an empty model sorts last by model both ways, as an unknown model', () => {
  const sessions = [
    session({ sessionId: 'known-a', topModel: 'a-model' }),
    session({ sessionId: 'empty', topModel: '' }),
    session({ sessionId: 'known-z', topModel: 'z-model' }),
  ];
  const order = (dir: SessionsQuery['dir']) =>
    sessionsPage(sessions, query({ dir, sort: 'model' }), NOW).sessions.map((one) => one.sessionId);
  expect(order('asc')).toEqual(['known-a', 'known-z', 'empty']);
  expect(order('desc')).toEqual(['known-z', 'known-a', 'empty']);
});

test('running Sessions lead every sort, a pick filters before the table is paged, and a page past the end reads as the first', () => {
  const sessions = [
    ...Array.from({ length: 30 }, (_, index) =>
      session({
        pricedCostUsd: index + 1,
        sessionId: `s${String(index).padStart(2, '0')}`,
        system: index < 27 ? 'server-1' : 'laptop-1',
      }),
    ),
    session({ lastRequestAt: NOW - 5 * 60_000, pricedCostUsd: 0, sessionId: 'running' }),
  ];
  for (const sort of SESSION_SORTS) {
    for (const dir of ['asc', 'desc'] as const) {
      const first = sessionsPage(sessions, query({ dir, sort }), NOW).sessions[0];
      expect({ dir, first: first?.sessionId, sort }).toEqual({ dir, first: 'running', sort });
    }
  }
  const picked = sessionsPage(
    sessions,
    query({ by: 'system', page: 2, pick: 'server-1', sort: 'cost' }),
    NOW,
  );
  expect(picked.total).toBe(28);
  expect(picked.page).toBe(2);
  expect(picked.sessions.map((one) => one.sessionId)).toEqual(['s02', 's01', 's00']);
  const past = sessionsPage(sessions, query({ by: 'system', page: 3, pick: 'server-1' }), NOW);
  expect(past.page).toBe(1);
  expect(past.sessions).toHaveLength(25);
  expect(sessionsPage([], query({ page: 4 }), NOW)).toEqual({ page: 1, sessions: [], total: 0 });
});
