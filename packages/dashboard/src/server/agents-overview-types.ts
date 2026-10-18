import type { SessionKey } from './session-view-types.ts';

export const AGENTS_RANGES = ['today', '7d', '30d'] as const;
export type AgentsRange = (typeof AGENTS_RANGES)[number];

export const AGENTS_BREAKDOWNS = ['project', 'system', 'model', 'harness'] as const;
export type AgentsBreakdown = (typeof AGENTS_BREAKDOWNS)[number];

// What a request with no model, and a Session with no working directory,
// group under.
export const UNKNOWN_MODEL = 'Unknown model';
export const NO_PROJECT = 'No working directory';

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
    // The models with a request in the period.
    models: string[];
    project: string | undefined;
  };

export type ModelTotals = PeriodTotals & { model: string };

export type AgentsOverview = {
  from: number;
  models: ModelTotals[];
  now: number;
  range: AgentsRange;
  sessions: AgentsSession[];
  timeZone: string;
  totals: PeriodTotals;
};
