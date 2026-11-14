// The pinned moment on the Activity axis: which changes it names, what its
// Sessions cost, and how a drag or the URL sets it.

import type { ActivityEvent } from '../server/activity-types.ts';
import type { MomentSession } from '../server/pinned-moment-types.ts';
import { stringList } from './filter-search.ts';
import { atFromSearch } from './range.ts';
import type { Window } from './time.ts';

// A pinned moment names the changes within this long of it, before or after.
export const NEAR_MS = 15 * 60_000;

const MINUTE_MS = 60_000;

// The changes within 15 minutes of `at`, on the pinned System when one is
// named, else on every System.
export const changesNear = (
  events: readonly ActivityEvent[],
  { at, system }: { at: number; system: string | undefined },
): ActivityEvent[] =>
  events.filter(
    (event) =>
      Math.abs(event.at - at) <= NEAR_MS && (system === undefined || event.system === system),
  );

// What the Sessions running at a moment cost at list price, over those that
// are priced, and how many Sessions hold an unpriced request.
export const momentTotal = (
  sessions: readonly MomentSession[],
): { unpriced: number; usd: number } => ({
  unpriced: sessions.filter(({ costUsd }) => costUsd === undefined).length,
  usd: sessions.reduce((sum, { costUsd }) => sum + (costUsd ?? 0), 0),
});

// "3 Sessions running · $2.17 list price", with the Sessions it cannot price
// counted apart, not folded into the sum.
export const sessionsSummary = (sessions: readonly MomentSession[]): string => {
  const { unpriced, usd } = momentTotal(sessions);
  const count = `${String(sessions.length)} Session${sessions.length === 1 ? '' : 's'} running`;
  if (sessions.length === 0) {
    return count;
  }
  const cost = `$${usd.toFixed(2)} list price`;
  return unpriced === 0 ? `${count} · ${cost}` : `${count} · ${cost}, ${String(unpriced)} unpriced`;
};

// The minute `fraction` of the way across the window, held to its edges.
export const timeAtFraction = (fraction: number, { from, to }: Window): number => {
  const t = from + Math.min(1, Math.max(0, fraction)) * (to - from);
  return Math.min(to, Math.max(from, Math.round(t / MINUTE_MS) * MINUTE_MS));
};

// The moment a URL pins: its time, and the System it was pinned on. Without a
// time there is no pin.
export const pinFromSearch = (
  search: Record<string, unknown>,
): { at: number; system: string | undefined } | undefined => {
  const at = atFromSearch({ at: search.pin });
  return at === undefined ? undefined : { at, system: stringList(search.pinOn)[0] };
};
