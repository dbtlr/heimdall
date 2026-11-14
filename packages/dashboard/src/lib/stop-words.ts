// A Service stop in words, as Activity, Home, and a System's events all say it.

import { formatSpan } from './time.ts';

// A stop still under way, or a finished one with how long it lasted, if known,
// and how often the Service restarted meanwhile. The stop itself is never
// called a restart: it is a stop, and the restart count is the supervisor's.
export const stopWords = (stop: {
  lasted: number | undefined;
  ongoing: boolean;
  restarts: number;
  service: string;
}): string => {
  if (stop.ongoing) {
    return `${stop.service} stopped`;
  }
  const restarts =
    stop.restarts > 0
      ? ` (restarted ${String(stop.restarts)} ${stop.restarts === 1 ? 'time' : 'times'})`
      : '';
  return stop.lasted === undefined
    ? `${stop.service} stopped, end unknown${restarts}`
    : `${stop.service} stopped for ${formatSpan(stop.lasted)}${restarts}`;
};
