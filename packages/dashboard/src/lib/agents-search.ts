import {
  AGENTS_BREAKDOWNS,
  AGENTS_RANGES,
  SESSION_SORTS,
} from '../server/agents-overview-types.ts';
import type { SessionsQuery, SortDirection } from '../server/agents-overview-types.ts';
import { DEFAULT_SORT, firstDirection } from './agents-sessions.ts';

// The IANA zone named, as Intl resolves it, or undefined for anything else.
export const validZone = (zone: unknown): string | undefined => {
  if (
    typeof zone !== 'string' ||
    zone.length > 100 ||
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(zone)
  ) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

// A breakdown row's key: a project, System, model, or Harness name, or the
// empty key of Sessions with no working directory and requests with no model.
const validPick = (pick: unknown): string | undefined =>
  typeof pick === 'string' && pick.length <= 4096 ? pick : undefined;

// The Sessions table is newest first, on page 1, unless the search says
// otherwise. A search holds only what differs from that, so a default stays
// out of the address, and a column's own first direction is no `dir`.
const validSort = (sort: unknown) =>
  SESSION_SORTS.find((known) => known === sort && known !== DEFAULT_SORT);
const validDirection = (dir: unknown): SortDirection | undefined =>
  dir === 'asc' || dir === 'desc' ? dir : undefined;

// A page number is a whole number from 2, the first page being the default.
// In the address it is plain digits, so "0x2", "2e0", and " 3 " are page 1.
// The ceiling keeps the offset a safe integer.
const MAX_PAGE = 1_000_000;
const validPage = (page: unknown): number | undefined => {
  const number = typeof page === 'string' && /^\d+$/u.test(page) ? Number(page) : page;
  return typeof number === 'number' && Number.isInteger(number) && number > 1 && number <= MAX_PAGE
    ? number
    : undefined;
};

export const agentsSearch = (search: Record<string, unknown>) => ({
  by: AGENTS_BREAKDOWNS.find((by) => by === search.by) ?? 'project',
  dir: validDirection(search.dir),
  page: validPage(search.page),
  pick: validPick(search.pick),
  range: AGENTS_RANGES.find((range) => range === search.range) ?? 'today',
  sort: validSort(search.sort),
  zone: validZone(search.zone),
});

// The Sessions table's query with its defaults filled in. The one place they
// are: the table's default query is `sessionsQueryOf(agentsSearch({}))`.
export const sessionsQueryOf = (search: ReturnType<typeof agentsSearch>): SessionsQuery => {
  const sort = search.sort ?? DEFAULT_SORT;
  return {
    by: search.by,
    dir: search.dir ?? firstDirection(sort),
    page: search.page ?? 1,
    pick: search.pick,
    sort,
  };
};

export const parseAgentsInput = (input: unknown) => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('range' in input) ||
    !('timeZone' in input)
  ) {
    throw new Error('Invalid Agents period');
  }
  const range = AGENTS_RANGES.find((candidate) => candidate === input.range);
  const timeZone = validZone(input.timeZone);
  if (range === undefined || timeZone === undefined) {
    throw new Error('Invalid Agents period');
  }
  return { ...sessionsQueryOf(agentsSearch(input)), range, timeZone };
};
