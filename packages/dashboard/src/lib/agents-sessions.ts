import { SESSIONS_PER_PAGE } from '../server/agents-overview-types.ts';
import type { SessionSort, SortDirection } from '../server/agents-overview-types.ts';

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

// The search params of an order, leaving out what the table does anyway:
// newest first is no `sort`, and a column's first direction is no `dir`.
export const sortSearch = ({ dir, sort }: { dir: SortDirection; sort: SessionSort }) => ({
  dir: dir === FIRST_DIRECTION[sort] ? undefined : dir,
  sort: sort === 'started' ? undefined : sort,
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
