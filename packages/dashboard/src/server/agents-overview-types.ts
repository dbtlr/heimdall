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
    branch: string | undefined;
    // The Session's first request, in the period or before it.
    firstRequestAt: number;
    lastRequestAt: number;
    // The models with a request in the period; NO_KEY for an empty model.
    models: string[];
    project: string | undefined;
    // The model with the most requests in the period, the first in code unit
    // order on a tie; NO_KEY for an empty model.
    topModel: string | undefined;
  };

// The Sessions table's columns that sort, in display order, and the direction.
export const SESSION_SORTS = [
  'started',
  'project',
  'harness',
  'model',
  'system',
  'duration',
  'requests',
  'cost',
] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];
export type SortDirection = 'asc' | 'desc';
export const SESSIONS_PER_PAGE = 25;

// How the Sessions table is ordered, filtered, and cut into pages; `pick` is
// the key of the breakdown row, of dimension `by`, the table is filtered to.
export type SessionsQuery = {
  by: AgentsBreakdown;
  dir: SortDirection;
  page: number;
  pick: string | undefined;
  sort: SessionSort;
};

// One page of the Sessions that match the query, and how many match in all.
export type SessionsPage = { page: number; sessions: AgentsSession[]; total: number };

// `model` is NO_KEY for requests with an empty model.
export type ModelTotals = PeriodTotals & { model: string };

// What one key of a breakdown cost over the period: a project, System, or
// Harness sums its Sessions, and a model its requests. NO_KEY for an unknown
// project or an empty model.
export type KeyTotals = PeriodTotals & { key: string };

// One bar of the cost chart: a local hour or a local day, from its first
// instant to the next one's.
export type CostBucket = { end: number; start: number };

// What requests in one bucket cost, per Harness, System, model, and project,
// the four ways the chart splits its bars. `project` and `model` are NO_KEY
// when unknown.
export type CostCell = {
  bucket: number;
  harness: string;
  model: string;
  pricedCostUsd: number;
  project: string;
  system: string;
  unpricedRequests: number;
};

export type CostChart = {
  buckets: CostBucket[];
  cells: CostCell[];
  // The Today range's bars span an hour; the others' a day.
  unit: 'day' | 'hour';
};

// The period's Sessions reach the browser only as these sums and the page of
// the table asked for, so the payload stays the same size however many there are.
export type AgentsOverview = {
  // Each breakdown's keys, unsorted.
  breakdown: Record<AgentsBreakdown, KeyTotals[]>;
  chart: CostChart;
  from: number;
  now: number;
  range: AgentsRange;
  // The Sessions running at `now`, most expensive first.
  running: AgentsSession[];
  // How many Sessions had a request in the period, and on how many Systems.
  sessionCount: number;
  systemCount: number;
  // The page of the Sessions table the search asked for.
  table: SessionsPage;
  timeZone: string;
  // What requests since local midnight cost.
  today: PeriodTotals;
  totals: PeriodTotals;
  // What is usually spent by now; undefined when too few days show it.
  usualByNow: number | undefined;
};
