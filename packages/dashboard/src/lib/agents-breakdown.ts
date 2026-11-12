import { NO_KEY, NO_PROJECT, UNKNOWN_MODEL } from '../server/agents-overview-types.ts';
import type {
  AgentsBreakdown,
  AgentsOverview,
  AgentsSession,
  KeyTotals,
  ModelTotals,
  PeriodTotals,
} from '../server/agents-overview-types.ts';
import { harnessColor, harnessName } from './lane.ts';

// How many keys the legend lists before the rest fold into "N more".
export const LEGEND_SHOWN = 5;

const SERIES_COLORS = [1, 2, 3, 4, 5].map((index) => `var(--series-${String(index)})`);
// Rows past the fifth share one neutral, which is no series color so the
// merged rest never reads as a row of its own.
export const NEUTRAL_COLOR = 'var(--chart-other)';

// `exact` has a list price for every request, `at-least` is a lower bound,
// and `none` has no priced request at all.
export type RowPricing = 'at-least' | 'exact' | 'none';

export type BreakdownRow = PeriodTotals & {
  color: string;
  key: string;
  name: string;
  // Share of the priced total in percent; undefined for a row with no list price.
  percent: number | undefined;
  pricing: RowPricing;
};

type Group = KeyTotals & { name: string };

const keyOf = (by: Exclude<AgentsBreakdown, 'model'>, session: AgentsSession): string =>
  by === 'project' ? (session.project ?? NO_KEY) : session[by === 'system' ? 'system' : 'harness'];

const NONE_LABELS: Partial<Record<AgentsBreakdown, string>> = {
  model: UNKNOWN_MODEL,
  project: NO_PROJECT,
};

// What a row shows for its key: the empty key gets a label, and a Harness its name.
export const nameOf = (by: AgentsBreakdown, key: string): string => {
  if (by === 'harness') {
    return harnessName(key);
  }
  return key === NO_KEY ? (NONE_LABELS[by] ?? key) : key;
};

// The Sessions' amounts summed per project, System, or Harness.
const groupSessions = (
  by: Exclude<AgentsBreakdown, 'model'>,
  sessions: readonly AgentsSession[],
): KeyTotals[] => {
  const groups = new Map<string, KeyTotals>();
  for (const session of sessions) {
    const key = keyOf(by, session);
    const group = groups.get(key) ?? { key, pricedCostUsd: 0, requests: 0, unpricedRequests: 0 };
    group.pricedCostUsd += session.pricedCostUsd;
    group.requests += session.requests;
    group.unpricedRequests += session.unpricedRequests;
    groups.set(key, group);
  }
  return [...groups.values()];
};

// The period's cost per key of each breakdown. Model totals come from the
// requests, since a Session can use several models.
export const breakdownTotals = (
  sessions: readonly AgentsSession[],
  models: readonly ModelTotals[],
): Record<AgentsBreakdown, KeyTotals[]> => ({
  harness: groupSessions('harness', sessions),
  model: models.map(({ model, ...totals }) => ({ ...totals, key: model })),
  project: groupSessions('project', sessions),
  system: groupSessions('system', sessions),
});

// The Sessions in the picked row's project, on its System, of its Harness, or
// that used its model.
export const sessionsIn = <S extends AgentsSession>(
  sessions: readonly S[],
  by: AgentsBreakdown,
  key: string,
): S[] =>
  by === 'model'
    ? sessions.filter((session) => session.models.includes(key))
    : sessions.filter((session) => keyOf(by, session) === key);

const pricingOf = (group: PeriodTotals): RowPricing => {
  if (group.unpricedRequests === 0) {
    return 'exact';
  }
  return group.unpricedRequests >= group.requests ? 'none' : 'at-least';
};

const byCostThenName = (left: Group, right: Group) => {
  if (left.pricedCostUsd !== right.pricedCostUsd) {
    return right.pricedCostUsd - left.pricedCostUsd;
  }
  return left.name.localeCompare(right.name);
};

const shareOf = (cost: number, total: number): number => (total === 0 ? 0 : (cost / total) * 100);

// The period's cost split by project, System, model, or Harness, highest
// priced cost first and ties by name. A Harness keeps its own color; in the
// other dimensions the top five rows take the series colors in order.
export const breakdownRows = (
  overview: Pick<AgentsOverview, 'breakdown'>,
  by: AgentsBreakdown,
): BreakdownRow[] => {
  const sorted = overview.breakdown[by]
    .map((group) => ({ ...group, name: nameOf(by, group.key) }))
    .toSorted(byCostThenName);
  const total = sorted.reduce((sum, group) => sum + group.pricedCostUsd, 0);
  return sorted.map((group, index) => {
    const pricing = pricingOf(group);
    return {
      color: by === 'harness' ? harnessColor(group.key) : (SERIES_COLORS[index] ?? NEUTRAL_COLOR),
      key: group.key,
      name: group.name,
      percent: pricing === 'none' ? undefined : shareOf(group.pricedCostUsd, total),
      pricedCostUsd: group.pricedCostUsd,
      pricing,
      requests: group.requests,
      unpricedRequests: group.unpricedRequests,
    };
  });
};

export const formatPercent = (percent: number | undefined): string => {
  if (percent === undefined) {
    return '';
  }
  const rounded = Math.round(percent);
  return rounded === 0 && percent > 0 ? '<1%' : `${String(rounded)}%`;
};
