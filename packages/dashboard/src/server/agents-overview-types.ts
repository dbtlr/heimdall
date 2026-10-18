import type { SessionKey } from './session-view-types.ts';

export const AGENTS_RANGES = ['today', '7d', '30d'] as const;
export type AgentsRange = (typeof AGENTS_RANGES)[number];

export const AGENTS_BREAKDOWNS = ['project', 'system', 'model', 'harness'] as const;
export type AgentsBreakdown = (typeof AGENTS_BREAKDOWNS)[number];

// The key a breakdown groups a request with an empty model, or a Session with
// no working directory, under: the empty string, which no model id or folder
// name can be, so no real name merges with them. The labels are only shown.
export const NO_KEY = '';
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
    // The models with a request in the period; NO_KEY for an empty model.
    models: string[];
    project: string | undefined;
  };

// `model` is NO_KEY for requests with an empty model.
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
