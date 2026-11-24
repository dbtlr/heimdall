import { describe, expect, test } from 'bun:test';

import type {
  LaunchTree,
  SessionTotals,
  TreeMember,
  TreeTotal,
} from '../server/session-view-types.ts';
import { costliestOf, outlineOf, showsLaunch, treeTotalText } from './launch-tree.ts';

const member = (sessionId: string, parent?: string): TreeMember => ({
  branch: undefined,
  costUsd: 1,
  endedAt: undefined,
  harness: 'claude-code',
  parent:
    parent === undefined
      ? undefined
      : { harness: 'claude-code', sessionId: parent, source: 'claude-code', system: 'laptop-1' },
  pricedCostUsd: 1,
  project: undefined,
  role: 'research',
  roleClass: 'delegated',
  seat: undefined,
  sessionId,
  source: 'claude-code',
  startedAt: undefined,
  system: 'laptop-1',
  totaled: true,
  unpricedRequests: 0,
});

describe('outlineOf', () => {
  test('puts each Session under the one that launched it, oldest first', () => {
    const rows = outlineOf([
      member('root'),
      member('a', 'root'),
      member('b', 'root'),
      member('a1', 'a'),
      member('b1', 'b'),
    ]);

    expect(rows.map(({ depth, member: { sessionId } }) => [sessionId, depth])).toEqual([
      ['root', 0],
      ['a', 1],
      ['a1', 2],
      ['b', 1],
      ['b1', 2],
    ]);
  });

  test('an empty tree has no outline', () => {
    expect(outlineOf([])).toEqual([]);
  });

  test('outlines a launch chain deeper than the call stack allows recursion', () => {
    const depth = 200_000;
    const chain = [member('s0')];
    for (let i = 1; i <= depth; i += 1) {
      chain.push(member(`s${String(i)}`, `s${String(i - 1)}`));
    }

    const rows = outlineOf(chain);

    expect(rows).toHaveLength(depth + 1);
    expect(rows.at(-1)?.depth).toBe(depth);
  });
});

describe('costliestOf', () => {
  test('finds the costliest member of a tree wider than a call can take as arguments', () => {
    const members = Array.from({ length: 300_000 }, (_, i) => ({
      ...member(`s${String(i)}`, 'root'),
      pricedCostUsd: i === 123_456 ? 42 : 1,
    }));

    expect(costliestOf(members)).toBe(42);
  });

  test('stays above zero for a tree with no priced cost, so bars never divide by zero', () => {
    expect(costliestOf([{ ...member('root'), pricedCostUsd: 0 }])).toBeGreaterThan(0);
  });
});

const OWN: SessionTotals = {
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

const TOTAL: TreeTotal = {
  costUsd: 31.89,
  missingSessions: 0,
  pricedCostUsd: 31.89,
  requests: 400,
  sessions: 6,
  unpricedRequests: 0,
};

// A tree of the given total whose root is totaled unless told otherwise.
const tree = (total: Partial<TreeTotal>, rootTotaled = true): LaunchTree => ({
  members: [{ ...member('root'), totaled: rootTotaled }, member('a', 'root')],
  total: { ...TOTAL, ...total },
});

describe('treeTotalText', () => {
  test('a fully priced tree has a list-price total', () => {
    expect(treeTotalText(tree({}), OWN)).toEqual({
      note: '6 Sessions, every request priced.',
      own: '$18.42',
      value: '$31.89',
    });
  });

  test('an unpriced request makes the total a lower bound', () => {
    expect(
      treeTotalText(tree({ costUsd: undefined, unpricedRequests: 3 }), {
        ...OWN,
        costUsd: undefined,
        unpricedRequests: 1,
      }),
    ).toEqual({
      note: '6 Sessions, 3 requests unpriced.',
      own: 'at least $18.42',
      value: 'At least $31.89',
    });
    expect(treeTotalText(tree({ costUsd: undefined, unpricedRequests: 1 }), OWN).note).toBe(
      '6 Sessions, 1 request unpriced.',
    );
  });

  test('a member not totaled yet leaves only a priced subtotal', () => {
    expect(
      treeTotalText(tree({ costUsd: undefined, missingSessions: 2, pricedCostUsd: 27.02 }), OWN),
    ).toEqual({
      note: '4 of 6 Sessions totaled; 2 are not totaled yet, so there is no list-price total.',
      own: '$18.42',
      value: 'Priced subtotal $27.02',
    });
    expect(
      treeTotalText(tree({ costUsd: undefined, missingSessions: 1, unpricedRequests: 2 }), OWN)
        .value,
    ).toBe('Priced subtotal $31.89');
    expect(treeTotalText(tree({ costUsd: undefined, missingSessions: 1 }), OWN).note).toBe(
      '5 of 6 Sessions totaled; 1 is not totaled yet, so there is no list-price total.',
    );
  });

  test('a root not totaled yet has no own total to give', () => {
    expect(treeTotalText(tree({}, false), OWN).own).toBeUndefined();
  });
});

describe('showsLaunch', () => {
  const none = {
    effectiveRole: undefined,
    effectiveSeat: undefined,
    launcher: undefined,
    role: undefined,
    roleClass: 'main' as const,
    roleSource: undefined,
    seat: undefined,
    tree: undefined,
  };

  test('a Session with no role, no launcher, and no launches shows no card', () => {
    expect(showsLaunch(none)).toBe(false);
  });

  test('any one of them shows it', () => {
    expect(showsLaunch({ ...none, role: 'research' })).toBe(true);
    expect(showsLaunch({ ...none, launcher: { id: 'x', state: 'unmatched' } })).toBe(true);
    expect(showsLaunch({ ...none, tree: { members: [], total: TOTAL } })).toBe(true);
  });
});
