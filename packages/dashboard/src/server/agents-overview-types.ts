import type { SessionKey } from './session-view-types.ts';

export const AGENTS_RANGES = ['today', '7d', '30d'] as const;
export type AgentsRange = (typeof AGENTS_RANGES)[number];

export type PeriodTotals = {
  pricedCostUsd: number;
  requests: number;
  unpricedRequests: number;
};

export type AgentsSession = SessionKey &
  PeriodTotals & {
    activeRecently: boolean;
    branch: string | undefined;
    lastRequestAt: number;
    project: string | undefined;
  };

export type AgentsOverview = {
  from: number;
  now: number;
  range: AgentsRange;
  sessions: AgentsSession[];
  timeZone: string;
  totals: PeriodTotals;
};
