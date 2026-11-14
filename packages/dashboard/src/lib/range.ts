import { isRange } from '../server/fleet-overview-types.ts';
import type { Range } from '../server/fleet-overview-types.ts';

export const RANGE_LABELS: Record<Range, string> = {
  '12h': '12 h',
  '24h': '24 h',
  '6h': '6 h',
  '7d': '7 d',
};

// The range a URL's `range` search parameter names, `fallback` (24h unless
// given) when it names none.
export const rangeFromSearch = (search: Record<string, unknown>, fallback: Range = '24h'): Range =>
  isRange(search.range) ? search.range : fallback;

// The time a URL's `at` search parameter names, in epoch milliseconds, or
// undefined when it names none.
export const atFromSearch = (search: Record<string, unknown>): number | undefined => {
  const at = typeof search.at === 'string' ? Number(search.at) : search.at;
  return typeof at === 'number' && Number.isFinite(at) ? Math.round(at) : undefined;
};
