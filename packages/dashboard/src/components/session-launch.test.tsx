import { expect, test } from 'bun:test';

import type { SessionLaunch, SessionTotals, TreeMember } from '../server/session-view-types.ts';
import { renderRouted } from './render-routed.tsx';
import { SessionTitle } from './session-header.tsx';
import { SessionLaunchCard } from './session-launch.tsx';

const NOW = Date.UTC(2026, 10, 24, 12);

const TOTALS: SessionTotals = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 18.42,
  inputTokens: 0,
  mainRequests: 0,
  outputTokens: 0,
  pricedCostUsd: 18.42,
  requests: 0,
  unpricedRequests: 0,
};

const LAUNCH: SessionLaunch = {
  effectiveRole: 'review',
  effectiveSeat: undefined,
  launcher: undefined,
  role: 'review',
  roleClass: 'review',
  roleSource: 'preamble',
  seat: undefined,
  tree: undefined,
};

const member = (sessionId: string, overrides: Partial<TreeMember> = {}): TreeMember => ({
  branch: 'main',
  costUsd: 1,
  endedAt: NOW,
  harness: 'codex',
  parent: undefined,
  pricedCostUsd: 1,
  project: 'heimdall',
  role: 'test',
  roleClass: 'delegated',
  seat: undefined,
  sessionId,
  source: 'codex',
  startedAt: NOW - 60_000,
  system: 'laptop-1',
  totaled: true,
  unpricedRequests: 0,
  ...overrides,
});

const card = (launch: Partial<SessionLaunch>) =>
  renderRouted(<SessionLaunchCard launch={{ ...LAUNCH, ...launch }} now={NOW} totals={TOTALS} />);

test('a role from the preamble says where it came from, and that no launcher was recorded', async () => {
  const html = await card({});

  expect(html).toContain('Not recorded');
  expect(html).toContain('seat unknown');
  expect(html).toContain(
    'from T3&#x27;s preamble; the brief had no session tag, so no seat or launcher',
  );
});

test('a role from a tag does not name its source', async () => {
  expect(await card({ roleSource: 'tag' })).not.toContain('preamble');
});

test('an unresolved launcher shows its raw id and why it does not link', async () => {
  const html = await card({ launcher: { id: '9b2e7d41-raw', state: 'unmatched' } });

  expect(html).toContain('9b2e7d41-raw');
  expect(html).toContain('Unresolved: no single Session the Hub holds has this id.');
});

test('an ambiguous launcher says more than one Session has its id', async () => {
  const html = await card({ launcher: { id: 'shared-id', state: 'ambiguous' } });

  expect(html).toContain('Unresolved: more than one Session the Hub holds has this id.');
  expect(html).not.toContain('transcripts arrive');
});

test('a launcher id naming this Session says so', async () => {
  const html = await card({ launcher: { id: 'own-id', state: 'self' } });

  expect(html).toContain('Unresolved: the id names this Session itself.');
  expect(html).not.toContain('no single Session');
});

test('a resolved launcher links its Session page', async () => {
  const html = await card({
    launcher: {
      session: member('parent-1', { harness: 'claude-code', source: 'claude-code' }),
      state: 'resolved',
    },
  });

  expect(html).toContain('href="/systems/laptop-1/sessions/claude-code/claude-code/parent-1"');
  expect(html).toContain('heimdall on main');
});

test('the tree outlines each launched Session, and one not totaled yet says so', async () => {
  const html = await card({
    tree: {
      members: [
        member('root', { costUsd: 18.42, role: 'review' }),
        member('child', {
          parent: { harness: 'codex', sessionId: 'root', source: 'codex', system: 'laptop-1' },
        }),
        member('late', { costUsd: undefined, totaled: false }),
      ],
      total: {
        costUsd: undefined,
        missingSessions: 1,
        pricedCostUsd: 19.42,
        requests: 10,
        sessions: 3,
        unpricedRequests: 0,
      },
    },
  });

  expect(html).toContain('Priced subtotal $19.42');
  expect(html).toContain('this Session');
  expect(html).toContain('href="/systems/laptop-1/sessions/codex/codex/child"');
  // The late member's row marks it, rather than giving its priced cost.
  expect(html).toContain('<span class="text-muted-foreground">not totaled yet</span>');
  expect(html).not.toContain('at least $1.00');
});

const parentOf = (sessionId: string) => ({
  harness: 'codex',
  sessionId,
  source: 'codex',
  system: 'laptop-1',
});

// A chain of `depth` launches under the root, each launched by the one before.
const chain = (depth: number) => [
  member('d0', { costUsd: 18.42 }),
  ...Array.from({ length: depth }, (_, index) =>
    member(`d${String(index + 1)}`, { parent: parentOf(`d${String(index)}`) }),
  ),
];

const TREE_TOTAL = {
  costUsd: 30,
  missingSessions: 0,
  pricedCostUsd: 30,
  requests: 10,
  sessions: 3,
  unpricedRequests: 0,
};

const indents = (html: string) =>
  [...html.matchAll(/<td class="py-2" style="padding-left:(\d+)(?:px)?">/g)].map((match) =>
    Number(match[1]),
  );

test('each launched Session nests under the one that launched it', async () => {
  const html = await card({ tree: { members: chain(3), total: TREE_TOTAL } });

  expect(indents(html)).toEqual([0, 0, 16, 32]);
});

test('past six levels the outline stops indenting and gives the depth', async () => {
  const html = await card({ tree: { members: chain(8), total: TREE_TOTAL } });

  expect(indents(html).slice(5)).toEqual([64, 80, 80, 80]);
  expect(html).toContain('aria-label="depth 8"');
  expect(html).not.toContain('aria-label="depth 6"');
});

test('members on one review seat share its shade', async () => {
  const review = (sessionId: string, seat: string) =>
    member(sessionId, { parent: parentOf('root'), role: 'review', roleClass: 'review', seat });
  const html = await card({
    tree: {
      members: [
        member('root', { costUsd: 18.42 }),
        review('b1', 'breaker'),
        review('b2', 'breaker'),
        review('b3', 'breaker'),
        review('v1', 'verifier'),
      ],
      total: TREE_TOTAL,
    },
  });

  const shades = [...html.matchAll(/background:var\(--review-(\w+)\)/g)].map((match) => match[1]);
  expect(shades).toEqual(['1', '1', '1', '2']);
});

test('a root not totaled yet says its own total is not stored', async () => {
  const html = await card({
    tree: {
      members: [
        member('root', { costUsd: undefined, totaled: false }),
        member('child', { parent: parentOf('root') }),
      ],
      total: { ...TREE_TOTAL, costUsd: undefined, missingSessions: 1 },
    },
  });

  expect(html).toContain('This Session&#x27;s own total is not stored yet.');
  expect(html).not.toContain('This Session alone');
});

test('the title carries the role pill only when the Session has a role', async () => {
  const view = { branch: 'main', harness: 'codex', project: 'heimdall', system: 'server-1' };

  expect(
    await renderRouted(<SessionTitle role={{ role: 'review', seat: 'breaker' }} view={view} />),
  ).toContain('breaker');
  expect(await renderRouted(<SessionTitle view={view} />)).not.toContain('rounded-[14px]');
});
