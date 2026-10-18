import { NO_PROJECT } from '../server/agents-overview-types.ts';
import type {
  AgentsBreakdown,
  AgentsOverview,
  AgentsSession,
  PeriodTotals,
} from '../server/agents-overview-types.ts';
import { harnessColor, harnessName } from './lane.ts';

// How many rows the list shows before the rest fold into "N more".
export const VISIBLE_ROWS = 8;

const SERIES_COLORS = [1, 2, 3, 4, 5].map((index) => `var(--chart-${String(index)})`);
const NEUTRAL_COLOR = 'var(--muted-foreground)';

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

type Group = PeriodTotals & { key: string; name: string };

const keyOf = (by: Exclude<AgentsBreakdown, 'model'>, session: AgentsSession): string =>
  by === 'project'
    ? (session.project ?? NO_PROJECT)
    : session[by === 'system' ? 'system' : 'harness'];

const groupSessions = (by: Exclude<AgentsBreakdown, 'model'>, sessions: AgentsSession[]) => {
  const groups = new Map<string, Group>();
  for (const session of sessions) {
    const key = keyOf(by, session);
    const group = groups.get(key) ?? {
      key,
      name: by === 'harness' ? harnessName(key) : key,
      pricedCostUsd: 0,
      requests: 0,
      unpricedRequests: 0,
    };
    group.pricedCostUsd += session.pricedCostUsd;
    group.requests += session.requests;
    group.unpricedRequests += session.unpricedRequests;
    groups.set(key, group);
  }
  return [...groups.values()];
};

// Model totals come from the overview: a Session can use several models.
const groupsOf = (overview: AgentsOverview, by: AgentsBreakdown): Group[] =>
  by === 'model'
    ? overview.models.map(({ model, ...totals }) => ({ ...totals, key: model, name: model }))
    : groupSessions(by, overview.sessions);

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
export const breakdownRows = (overview: AgentsOverview, by: AgentsBreakdown): BreakdownRow[] => {
  const sorted = groupsOf(overview, by).toSorted(byCostThenName);
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

export type BarSegment = { color: string; key: string; percent: number };

// The stacked bar: one segment per colored row, and the neutral rows combined
// into one. A row with no priced cost has no width.
export const barSegments = (rows: BreakdownRow[]): BarSegment[] => {
  const segments: BarSegment[] = [];
  for (const row of rows) {
    const percent = row.percent ?? 0;
    const last = segments.at(-1);
    if (percent === 0) {
      continue;
    }
    if (row.color === NEUTRAL_COLOR && last?.color === NEUTRAL_COLOR) {
      last.percent += percent;
    } else {
      segments.push({ color: row.color, key: row.key, percent });
    }
  }
  return segments;
};

export const formatPercent = (percent: number | undefined): string => {
  if (percent === undefined) {
    return '';
  }
  const rounded = Math.round(percent);
  return rounded === 0 && percent > 0 ? '<1%' : `${String(rounded)}%`;
};

// The Sessions in the picked row's project, on its System, of its Harness, or
// that used its model.
export const sessionsIn = (
  sessions: AgentsSession[],
  by: AgentsBreakdown,
  key: string,
): AgentsSession[] =>
  by === 'model'
    ? sessions.filter((session) => session.models.includes(key))
    : sessions.filter((session) => keyOf(by, session) === key);
