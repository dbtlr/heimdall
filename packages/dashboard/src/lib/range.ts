import { isRange } from '../server/fleet-overview-types.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import { formatClock } from './time.ts';

export const RANGE_LABELS: Record<Range, string> = {
  '12h': '12 h',
  '24h': '24 h',
  '6h': '6 h',
  '7d': '7 d',
};

const RANGE_NAMES: Record<Range, string> = {
  '12h': '12 hours',
  '24h': '24 hours',
  '6h': '6 hours',
  '7d': '7 days',
};

// The range a URL's `range` search parameter names, 24h when it names none.
export const rangeFromSearch = (search: Record<string, unknown>): Range =>
  isRange(search.range) ? search.range : '24h';

// The page title, "Last 24 hours, to 16:00".
export const rangeTitle = (range: Range, to: number, timeZone: string): string =>
  `Last ${RANGE_NAMES[range]}, to ${formatClock(to, timeZone)}`;
