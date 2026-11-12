import { NO_KEY, SESSIONS_PER_PAGE } from '../server/agents-overview-types.ts';
import type {
  AgentsSession,
  SessionSort,
  SessionsPage,
  SessionsQuery,
  SortDirection,
} from '../server/agents-overview-types.ts';
import { sessionsIn } from './agents-breakdown.ts';
import { isRunning } from './home-agents.ts';

// Words sort from A, and a time or an amount from the most.
const FIRST_DIRECTION: Record<SessionSort, SortDirection> = {
  cost: 'desc',
  duration: 'desc',
  harness: 'asc',
  model: 'asc',
  project: 'asc',
  requests: 'desc',
  started: 'desc',
  system: 'asc',
};

export const firstDirection = (sort: SessionSort): SortDirection => FIRST_DIRECTION[sort];

// The table's order without a `sort` in the search: newest first.
export const DEFAULT_SORT: SessionSort = 'started';

// The search params of an order, leaving out what the table does anyway:
// the default sort is no `sort`, and a column's first direction is no `dir`.
export const sortSearch = ({ dir, sort }: { dir: SortDirection; sort: SessionSort }) => ({
  dir: dir === FIRST_DIRECTION[sort] ? undefined : dir,
  sort: sort === DEFAULT_SORT ? undefined : sort,
});

// What picking a column header sorts by: the column's first direction, or the
// other direction when the table is already sorted by it.
export const nextSort = (
  current: { dir: SortDirection; sort: SessionSort },
  column: SessionSort,
): { dir: SortDirection; sort: SessionSort } => {
  if (current.sort !== column) {
    return { dir: FIRST_DIRECTION[column], sort: column };
  }
  return { dir: current.dir === 'asc' ? 'desc' : 'asc', sort: column };
};

export const pageCount = (total: number): number =>
  Math.max(1, Math.ceil(total / SESSIONS_PER_PAGE));

// The numbers of the Sessions a page shows, counted from 1, as in "26-50 of 96".
export const pageRange = (page: number, shown: number): { first: number; last: number } => ({
  first: (page - 1) * SESSIONS_PER_PAGE + 1,
  last: (page - 1) * SESSIONS_PER_PAGE + shown,
});

// The pager's buttons: the first and last page, the current one and its
// neighbours, and the first three pages while near the start. A gap of one
// page shows that page instead of an ellipsis.
export const pageButtons = (page: number, pages: number): (number | 'gap')[] => {
  const shown = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 2) {
    shown.add(3);
  }
  if (page >= pages - 1) {
    shown.add(pages - 2);
  }
  const numbers = [...shown]
    .filter((number) => number >= 1 && number <= pages)
    .toSorted((left, right) => left - right);
  const buttons: (number | 'gap')[] = [];
  for (const [index, number] of numbers.entries()) {
    const before = numbers[index - 1];
    if (before !== undefined && number - before === 2) {
      buttons.push(before + 1);
    } else if (before !== undefined && number - before > 2) {
      buttons.push('gap');
    }
    buttons.push(number);
  }
  return buttons;
};

// What each column sorts a Session by; undefined sorts last both ways, and so
// does an empty model, which the table shows as unknown.
const SORT_VALUES: Record<SessionSort, (session: AgentsSession) => number | string | undefined> = {
  cost: (session) => session.pricedCostUsd,
  duration: (session) => session.lastRequestAt - session.firstRequestAt,
  harness: (session) => session.harness,
  model: (session) => (session.topModel === NO_KEY ? undefined : session.topModel),
  project: (session) => session.project,
  requests: (session) => session.requests,
  started: (session) => session.firstRequestAt,
  system: (session) => session.system,
};

// Numbers by size and words by code unit, as the breakdown's keys are.
const compareValues = (left: number | string, right: number | string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

// The Session's identity, which breaks every tie, so a Session keeps its
// place from one page to the next whatever order the Sessions arrive in.
const identityOf = (session: AgentsSession) =>
  [session.system, session.harness, session.source, session.sessionId] as const;

const compareIdentity = (left: AgentsSession, right: AgentsSession): number => {
  const rightIdentity = identityOf(right);
  for (const [index, part] of identityOf(left).entries()) {
    const order = compareValues(part, rightIdentity[index] ?? '');
    if (order !== 0) {
      return order;
    }
  }
  return 0;
};

// The order of the Sessions table: running Sessions first, then the column in
// the direction asked, a Session with no value for it last, then identity.
const compareSessions =
  ({ dir, sort }: Pick<SessionsQuery, 'dir' | 'sort'>, now: number) =>
  (left: AgentsSession, right: AgentsSession): number => {
    const running =
      Number(isRunning(right.lastRequestAt, now)) - Number(isRunning(left.lastRequestAt, now));
    if (running !== 0) {
      return running;
    }
    const leftValue = SORT_VALUES[sort](left);
    const rightValue = SORT_VALUES[sort](right);
    if (leftValue === undefined || rightValue === undefined) {
      const missing = Number(leftValue === undefined) - Number(rightValue === undefined);
      if (missing !== 0) {
        return missing;
      }
    } else {
      const order = compareValues(leftValue, rightValue);
      if (order !== 0) {
        return dir === 'asc' ? order : -order;
      }
    }
    return compareIdentity(left, right);
  };

// The page of the period's Sessions the query asks for: those matching its
// pick, sorted, 25 a page. A page past the last one reads as the first, so a
// link to a page that no longer exists still shows Sessions.
export const sessionsPage = (
  sessions: readonly AgentsSession[],
  { by, dir, page, pick, sort }: SessionsQuery,
  now: number,
): SessionsPage => {
  const matching = pick === undefined ? [...sessions] : sessionsIn(sessions, by, pick);
  const sorted = matching.toSorted(compareSessions({ dir, sort }, now));
  const shown = page > pageCount(sorted.length) ? 1 : page;
  const start = (shown - 1) * SESSIONS_PER_PAGE;
  return {
    page: shown,
    sessions: sorted.slice(start, start + SESSIONS_PER_PAGE),
    total: sorted.length,
  };
};
