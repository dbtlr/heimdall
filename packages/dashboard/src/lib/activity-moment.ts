// The pinned moment on the Activity axis: which changes it names, what its
// Sessions cost, and how a drag or the URL sets it.

import { ACTIVITY_RANGE_MS } from '../server/activity-types.ts';
import type { ActivityEvent } from '../server/activity-types.ts';
import { field } from '../server/hub-rows.ts';
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
const momentTotal = (sessions: readonly MomentSession[]): { unpriced: number; usd: number } => ({
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

// The pin a URL names when it falls inside the window the page shows, else
// none: a pin kept from a longer range or an old link names a moment off the
// axis, and reading it would cost the Sessions since then.
export const pinWithin = <P extends { at: number }>(
  pin: P | undefined,
  { from, to }: Window,
): P | undefined => (pin !== undefined && pin.at >= from && pin.at <= to ? pin : undefined);

// How much older than Activity's longest range a pin may be. The page sets its
// window when it loads and keeps it while open, so a pin at the window's start
// reaches the server later than the window's `now`, by the clocks' skew and by
// however long the page has been open.
export const MOMENT_SLACK_MS = 24 * 60 * 60_000;

// The oldest moment the pinned-moment read answers, at `now`: the start of
// Activity's longest range, less the slack, so its cost follows that range and
// not the archive.
const oldestMoment = (now: number) =>
  now - Math.max(...Object.values(ACTIVITY_RANGE_MS)) - MOMENT_SLACK_MS;

// What a pinned-moment request asks for, at the server's `now`: a time no older
// than Activity's longest range and the slack, and the System it was pinned
// on, if any.
export const momentInput = (
  input: unknown,
  now: number,
): { at: number; system: string | undefined } => {
  const at = field(input, 'at');
  const system = field(input, 'system');
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new TypeError('The pinned moment needs a time.');
  }
  if (at < oldestMoment(now)) {
    throw new RangeError('The pinned moment is older than the longest Activity range and a day.');
  }
  return { at, system: typeof system === 'string' ? system : undefined };
};
