// The Session page's running cost split by effective role (ADR-0025): the main
// conversation, then its subagents by review seat, then delegated subagents.

import type {
  SessionConversation,
  SessionLaunch,
  SessionRequest,
} from '../server/session-view-types.ts';
import { costClassColor, listSeats, roleText } from './cost-roles.ts';

/** One stacked series of the running cost, bottom first. */
export type RoleSeries = {
  color: string;
  // The point field the series reads.
  key: string;
  label: string;
};

export type RoleRunningCost = {
  // One point per request, oldest first: `t` and each series' running cost.
  points: Record<string, number>[];
  series: RoleSeries[];
};

type Group = { kind: 'delegated' } | { kind: 'main' } | { kind: 'review'; seat: string | null };

const MAIN = 'main';
const DELEGATED = 'delegated';

// Which part of the split a request counts under: its conversation's class as
// the Hub gives it (insight.conversation_roles), which also covers a subagent
// the Hub holds no row for. A conversation with no class from the Hub counts as
// delegated.
const groupOf = (
  request: Pick<SessionRequest, 'agentId'>,
  classes: ReadonlyMap<string, Pick<SessionConversation, 'roleClass' | 'seat'>>,
): Group => {
  if (request.agentId === undefined) {
    return { kind: 'main' };
  }
  const found = classes.get(request.agentId);
  return found?.roleClass === 'review'
    ? { kind: 'review', seat: found.seat ?? null }
    : { kind: 'delegated' };
};

/** The main conversation's legend label: its role beside it when it has one. */
export const mainLabel = (launch: Pick<SessionLaunch, 'role' | 'seat'>): string => {
  const role = roleText(launch.role ?? null, launch.seat ?? null);
  return role === null ? 'main conversation' : `main conversation · ${role}`;
};

/**
 * The running list-price cost of the main conversation and of the subagents
 * by effective role. Review seats come as {@link listSeats} lists them, so the
 * chart rolls up seats as the Agents page does. A part with no requests
 * has no series, except the main conversation's.
 */
export const roleRunningCost = (
  requests: readonly SessionRequest[],
  launch: Pick<SessionLaunch, 'role' | 'seat'>,
  conversations: readonly SessionConversation[],
): RoleRunningCost => {
  // The Hub's class for each subagent conversation, held or not.
  const byId = new Map(
    conversations.map((conversation): [string, SessionConversation] => [
      conversation.agentId,
      conversation,
    ]),
  );
  const sorted = requests.toSorted((a, b) => a.at - b.at);
  const groups = sorted.map((request) => groupOf(request, byId));
  const seatCosts = new Map<string | null, number>();
  for (const [index, group] of groups.entries()) {
    if (group.kind === 'review') {
      seatCosts.set(group.seat, (seatCosts.get(group.seat) ?? 0) + (sorted[index]?.costUsd ?? 0));
    }
  }
  const lines = listSeats([...seatCosts].map(([seat, cost]) => ({ cost, seat })));
  // Each seat's series: its own line's, or the shared one it is rolled into.
  const seriesOfSeat = new Map<string | null, string>();
  const series: RoleSeries[] = [
    { color: costClassColor('main'), key: MAIN, label: mainLabel(launch) },
  ];
  for (const [index, line] of lines.entries()) {
    const key = line.key === 'more' ? 'more' : `s${String(index)}`;
    for (const seat of line.seats) {
      seriesOfSeat.set(seat, key);
    }
    series.push({ color: line.shade, key, label: roleText('review', line.name) });
  }
  if (groups.some((group) => group.kind === 'delegated')) {
    series.push({
      color: costClassColor('delegated'),
      key: DELEGATED,
      label: 'delegated subagents',
    });
  }
  const running = new Map(series.map(({ key }) => [key, 0]));
  const points = sorted.map((request, index) => {
    const group: Group = groups[index] ?? { kind: 'main' };
    const key = group.kind === 'review' ? (seriesOfSeat.get(group.seat) ?? 'more') : group.kind;
    running.set(key, (running.get(key) ?? 0) + (request.costUsd ?? 0));
    // Each point keeps its own copy of the running sums.
    return Object.fromEntries([...running, ['t', request.at]]);
  });
  return { points, series };
};

/**
 * The note under the chart: how subagents are split, and how this Session's
 * own conversations count on the Agents page.
 */
export const roleSplitNote = (launch: Pick<SessionLaunch, 'role' | 'seat'>): string => {
  const role = roleText(launch.role ?? null, launch.seat ?? null);
  if (role === null) {
    return "Subagents are split by their effective role: their own, else their parent subagent's. A subagent with neither counts as delegated on the Agents page, and the main conversation as main.";
  }
  const counted = launch.role === 'review' ? 'as review' : 'as delegated';
  return `Subagents are split by their effective role: their own, else their parent subagent's, else this Session's, ${role}. This Session's main conversation, and every subagent that takes its role, counts ${counted} on the Agents page.`;
};
