import { describe, expect, test } from 'bun:test';

import type { SessionAgent, SessionRequest } from '../server/session-view-types.ts';
import { SEATS_LISTED } from './cost-roles.ts';
import { mainLabel, roleRunningCost, roleSplitNote } from './running-cost-by-role.ts';

const request = (at: number, costUsd: number | undefined, agentId?: string): SessionRequest => ({
  agentId,
  at,
  cacheReadCostUsd: undefined,
  cacheReadTokens: 0,
  cacheWriteCostUsd: undefined,
  cacheWriteTokens: 0,
  contextTokens: 0,
  contextWindow: undefined,
  costUsd,
  inputCostUsd: undefined,
  inputTokens: 0,
  interrupted: false,
  model: 'm',
  outputCostUsd: undefined,
  outputTokens: 0,
  requestId: `r${String(at)}`,
  skill: undefined,
  stopReason: 'end_turn',
});

const agent = (
  agentId: string,
  effectiveRole: string | undefined,
  effectiveSeat?: string,
  roleClass: SessionAgent['roleClass'] = effectiveRole === 'review' ? 'review' : 'delegated',
): SessionAgent => ({
  agentId,
  agentType: undefined,
  depth: 1,
  effectiveRole,
  effectiveSeat,
  endedAt: 0,
  parentAgentId: undefined,
  roleClass,
  startedAt: 0,
  workflowPhase: undefined,
  workflowRun: undefined,
});

const IMPLEMENTATION = {
  effectiveRole: 'implementation',
  effectiveSeat: undefined,
  role: 'implementation',
  seat: undefined,
};

describe('roleRunningCost', () => {
  test('stacks the main conversation, each review seat, then delegated subagents', () => {
    const split = roleRunningCost(
      [
        request(1, 1),
        request(2, 2, 'arch'),
        request(3, 3, 'plain'),
        request(4, 4, 'brk'),
        request(5, 5, 'arch'),
      ],
      [
        agent('arch', 'review', 'architect'),
        agent('brk', 'review', 'breaker'),
        agent('plain', 'implementation'),
      ],
      IMPLEMENTATION,
    );

    expect(split.series).toEqual([
      { color: 'var(--plot)', key: 'main', label: 'main conversation · implementation' },
      { color: 'var(--review-1)', key: 's0', label: 'review · architect' },
      { color: 'var(--review-2)', key: 's1', label: 'review · breaker' },
      { color: 'var(--series-1)', key: 'delegated', label: 'delegated subagents' },
    ]);
    expect(split.points.at(-1)).toEqual({ delegated: 3, main: 1, s0: 7, s1: 4, t: 5 });
    expect(split.points.map((point) => point.t)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a review Session’s untagged subagents count under its seat', () => {
    const split = roleRunningCost(
      [request(1, 1), request(2, 2, 'plain'), request(3, 4, 'unheld')],
      [agent('plain', 'review', 'breaker')],
      { effectiveRole: 'review', effectiveSeat: 'breaker', role: 'review', seat: 'breaker' },
    );

    expect(split.series.map((series) => series.label)).toEqual([
      'main conversation · review · breaker',
      'review · breaker',
    ]);
    // A subagent the Hub holds no row for takes the Session's role.
    expect(split.points.at(-1)).toEqual({ main: 1, s0: 6, t: 3 });
  });

  test('an unknown seat is its own series, hatched and last among the seats', () => {
    const split = roleRunningCost(
      [request(1, 9, 'unknown'), request(2, 1, 'arch')],
      [agent('unknown', 'review'), agent('arch', 'review', 'architect')],
      IMPLEMENTATION,
    );

    expect(split.series.slice(1)).toEqual([
      { color: 'var(--review-1)', key: 's0', label: 'review · architect' },
      { color: 'var(--review-unknown)', key: 's1', label: 'review · seat unknown' },
    ]);
  });

  test('past six known seats, keeps five and rolls the rest into one series before the unknown seat', () => {
    const seats = Array.from({ length: SEATS_LISTED + 1 }, (_, index) => `seat-${String(index)}`);
    const split = roleRunningCost(
      [...seats.map((seat, index) => request(index, 100 - index, seat)), request(10, 1, 'unknown')],
      [...seats.map((seat) => agent(seat, 'review', seat)), agent('unknown', 'review')],
      IMPLEMENTATION,
    );

    expect(split.series.slice(5)).toEqual([
      { color: 'var(--review-other)', key: 's4', label: 'review · seat-4' },
      { color: 'var(--review-other)', key: 'more', label: 'review · 2 more seats' },
      { color: 'var(--review-unknown)', key: 's6', label: 'review · seat unknown' },
    ]);
    expect(split.points.at(-1)).toMatchObject({ more: 95 + 94, s4: 96, s6: 1 });
  });

  test('a held subagent counts under the class the Hub gives it', () => {
    const split = roleRunningCost(
      [request(1, 2, 'odd')],
      [agent('odd', 'review', 'breaker', 'delegated')],
      IMPLEMENTATION,
    );

    expect(split.points.at(-1)).toEqual({ delegated: 2, main: 0, t: 1 });
  });

  test('a Session with no role has a plain main series and no empty ones', () => {
    const split = roleRunningCost([request(1, 1), request(2, undefined)], [], {
      effectiveRole: undefined,
      effectiveSeat: undefined,
      role: undefined,
      seat: undefined,
    });

    expect(split.series).toEqual([
      { color: 'var(--plot)', key: 'main', label: 'main conversation' },
    ]);
    expect(split.points.at(-1)).toEqual({ main: 1, t: 2 });
  });

  test('points follow time, not input order', () => {
    const split = roleRunningCost([request(5, 2), request(1, 1)], [], IMPLEMENTATION);

    expect(split.points).toEqual([
      { main: 1, t: 1 },
      { main: 3, t: 5 },
    ]);
  });
});

describe('the chart’s labels', () => {
  test('the main conversation names the Session’s role', () => {
    expect(mainLabel({ role: undefined, seat: undefined })).toBe('main conversation');
    expect(mainLabel({ role: 'review', seat: undefined })).toBe(
      'main conversation · review · seat unknown',
    );
  });

  test('the note says how the Session’s own conversations count', () => {
    expect(roleSplitNote({ role: 'implementation', seat: undefined })).toBe(
      "Subagents are split by their effective role: their own, else their parent subagent's, else this Session's, implementation. This Session's main conversation, and every subagent that takes its role, counts as delegated on the Agents page.",
    );
    expect(roleSplitNote({ role: 'review', seat: 'breaker' })).toContain(
      "else this Session's, review · breaker. This Session's main conversation, and every subagent that takes its role, counts as review on the Agents page.",
    );
    expect(roleSplitNote({ role: undefined, seat: undefined })).toBe(
      "Subagents are split by their effective role: their own, else their parent subagent's. A subagent with neither counts as delegated on the Agents page, and the main conversation as main.",
    );
  });
});
