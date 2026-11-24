// The Session page's launch tree (ADR-0025): the outline of the Sessions a
// Session launched, and what its tree total says in each of its three states.

import type {
  LaunchTree,
  SessionKey,
  SessionLaunch,
  SessionTotals,
  TreeMember,
} from '../server/session-view-types.ts';
import { formatCost } from './time.ts';

export type OutlineRow = { depth: number; member: TreeMember };

const keyOf = ({ harness, sessionId, source, system }: SessionKey) =>
  JSON.stringify([harness, system, source, sessionId]);

/**
 * The tree as an outline: the root at depth 0, then each Session under the
 * one that launched it, in the order the members arrive (oldest first). It
 * assumes what session_tree gives: the root first, and every other member's
 * parent in the tree.
 */
export const outlineOf = (members: readonly TreeMember[]): OutlineRow[] => {
  const [root, ...rest] = members;
  if (root === undefined) {
    return [];
  }
  const children = new Map<string, TreeMember[]>();
  for (const member of rest) {
    const parent = keyOf(member.parent ?? root);
    const siblings = children.get(parent);
    if (siblings === undefined) {
      children.set(parent, [member]);
    } else {
      siblings.push(member);
    }
  }
  // Depth first with a stack of its own, so a chain of any depth fits; each
  // Session's children go on in reverse, so they come off oldest first.
  const rows: OutlineRow[] = [];
  const pending: OutlineRow[] = [{ depth: 0, member: root }];
  for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
    rows.push(row);
    const launched = children.get(keyOf(row.member)) ?? [];
    for (const member of launched.toReversed()) {
      pending.push({ depth: row.depth + 1, member });
    }
  }
  return rows;
};

// The largest priced cost in a tree, which every row's bar is drawn against.
// A reduce, not a spread, so a tree of any width fits; never below a tiny
// floor, so a tree with no priced cost divides by no zero.
export const costliestOf = (members: readonly TreeMember[]): number =>
  members.reduce((max, member) => Math.max(max, member.pricedCostUsd), 0.000_001);

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export type TreeTotalText = {
  // The headline amount, with what it is when it is not the full total.
  value: string;
  // What the amount covers.
  note: string;
  // This Session's own total, subagents included, as a phrase; undefined
  // while its totals are not stored yet.
  own: string | undefined;
};

const ownCostOf = (own: SessionTotals) =>
  own.costUsd === undefined ? `at least ${formatCost(own.pricedCostUsd)}` : formatCost(own.costUsd);

/**
 * What the tree total says: the list-price total when every member is totaled
 * and every request priced, a lower bound while a request is unpriced, and
 * only a priced subtotal while a member's totals are not stored yet.
 */
export const treeTotalText = (
  { members, total }: LaunchTree,
  own: SessionTotals,
): TreeTotalText => {
  const ownCost = members[0]?.totaled === true ? ownCostOf(own) : undefined;
  if (total.missingSessions > 0) {
    const totaled = total.sessions - total.missingSessions;
    return {
      note: `${String(totaled)} of ${count(total.sessions, 'Session', 'Sessions')} totaled; ${String(total.missingSessions)} ${total.missingSessions === 1 ? 'is' : 'are'} not totaled yet, so there is no list-price total.`,
      own: ownCost,
      value: `Priced subtotal ${formatCost(total.pricedCostUsd)}`,
    };
  }
  if (total.costUsd === undefined) {
    return {
      note: `${count(total.sessions, 'Session', 'Sessions')}, ${count(total.unpricedRequests, 'request', 'requests')} unpriced.`,
      own: ownCost,
      value: `At least ${formatCost(total.pricedCostUsd)}`,
    };
  }
  return {
    note: `${count(total.sessions, 'Session', 'Sessions')}, every request priced.`,
    own: ownCost,
    value: formatCost(total.costUsd),
  };
};

/**
 * Whether the page shows the launch-tree card: only for a Session with a role,
 * a launcher, or Sessions it launched. Any other Session's page is as it was.
 */
export const showsLaunch = (launch: SessionLaunch): boolean =>
  launch.role !== undefined || launch.launcher !== undefined || launch.tree !== undefined;
