import type { Range } from '../server/fleet-overview-types.ts';
import { formatClock, formatWeekday, localDayNumber, localHourMinute, xPercent } from './time.ts';
import type { Window } from './time.ts';

export type Tick = {
  at: number;
  // Where the label sits against its tick: the first is left-aligned, the last right-aligned.
  edge: 'end' | 'middle' | 'start';
  label: string;
  // Dropped on a narrow screen to leave room.
  minor: boolean;
};

const QUARTER_HOUR_MS = 15 * 60_000;
// A round tick this close to either end, in percent of the window, would
// crowd the first label or "now".
const EDGE_CLEARANCE_PERCENT = 10;

// Round local hours that get a tick, and the multiple of them that is major.
const HOUR_STEPS: Record<Exclude<Range, '7d'>, { major: number; step: number }> = {
  '12h': { major: 4, step: 2 },
  '24h': { major: 8, step: 4 },
  '6h': { major: 2, step: 1 },
};

// The ticks along a window: the first at its start, round local times between,
// and "now" at its end. 7d ticks each local midnight, labeled by weekday.
export const axisTicks = (range: Range, window: Window, timeZone: string): Tick[] => {
  const { from, to } = window;
  const weekly = range === '7d';
  const ticks: Tick[] = [
    {
      at: from,
      edge: 'start',
      label: weekly ? formatWeekday(from, timeZone) : formatClock(from, timeZone),
      minor: false,
    },
  ];
  const first = Math.ceil((from + 1) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  for (let at = first; at < to; at += QUARTER_HOUR_MS) {
    const percent = xPercent(at, window);
    if (percent < EDGE_CLEARANCE_PERCENT || percent > 100 - EDGE_CLEARANCE_PERCENT) {
      continue;
    }
    const { hour, minute } = localHourMinute(at, timeZone);
    if (minute !== 0) {
      continue;
    }
    if (weekly) {
      if (hour === 0) {
        ticks.push({
          at,
          edge: 'middle',
          label: formatWeekday(at, timeZone),
          minor: localDayNumber(at, timeZone) % 2 === 0,
        });
      }
    } else {
      const { major, step } = HOUR_STEPS[range];
      if (hour % step === 0) {
        ticks.push({
          at,
          edge: 'middle',
          label: formatClock(at, timeZone),
          minor: hour % major !== 0,
        });
      }
    }
  }
  ticks.push({ at: to, edge: 'end', label: 'now', minor: false });
  return ticks;
};
