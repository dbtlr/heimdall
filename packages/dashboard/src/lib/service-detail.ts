// What a Service page says, as plain values the components only render: its
// history of stops and Service down raises and clears, newest first, the
// summary counts, and the 90-day strip of ticks. The times that depend on the
// viewer's zone stay phrases, or take the zone as an argument.

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import { clockSecondsAt, whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { SUPERVISOR_NAMES } from './recorded.ts';
import { formatSpan, formatSpanShort, xPercent } from './time.ts';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

// The Hub keeps stops for this long, and the strip spans it.
export const WINDOW_DAYS = 90;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;
// The history shows this many rows until asked for the older ones.
export const HISTORY_LIMIT = 6;
// A stop received later than this after it was sent says so.
const LATE_MS = 2 * MINUTE_MS;
// A tick is this tall with no restarts, and grows to full height at CAP restarts.
const TICK_BASE = 40;
const TICK_RESTARTS_CAP = 8;

const UNKNOWN_RESULT =
  'Unknown. systemd forgot it because the Service stopped and ran again between two checks.';

export type StopDot = 'bad' | 'good' | 'unknown';

export type StopRow = {
  details: { label: string; value: Phrase }[];
  dot: StopDot;
  // How long it was down, or why that is not known.
  duration: string;
  // A stop whose result is a failure; the strip draws its tick in the serious color.
  failure: boolean;
  // How long after it was sent it was received, when later than 2 minutes.
  late: string | undefined;
  restarts: string | undefined;
  stoppedAt: number;
  title: Phrase;
};

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

const isFailure = (stop: ServiceStop) => stop.result !== null && stop.result !== 'success';

const stillDown = (stop: ServiceStop) => stop.ongoing && stop.startedAt === null;

const resultWords = (stop: ServiceStop): string => {
  const status = stop.exitStatus === null ? 'unknown' : String(stop.exitStatus);
  switch (stop.result) {
    case null: {
      return 'Result unknown';
    }
    case 'success': {
      return 'Stopped cleanly';
    }
    case 'signal': {
      return `Killed, signal ${status}`;
    }
    case 'exit-code': {
      return `Failed, exit-code ${status}`;
    }
    default: {
      return `Stopped: ${stop.result}${stop.exitStatus === null ? '' : `, exit status ${String(stop.exitStatus)}`}`;
    }
  }
};

const dotOf = (stop: ServiceStop): StopDot => {
  if (stillDown(stop) || isFailure(stop)) {
    return 'bad';
  }
  return stop.result === null ? 'unknown' : 'good';
};

const durationOf = (stop: ServiceStop, now: number): string => {
  const stoppedAt = Date.parse(stop.stoppedAt);
  if (stop.startedAt !== null) {
    return formatSpan(Math.max(0, Date.parse(stop.startedAt) - stoppedAt));
  }
  return stop.ongoing ? formatSpanShort(Math.max(0, now - stoppedAt)) : 'End unknown';
};

const resultDetail = (stop: ServiceStop): string => {
  if (stop.result === null) {
    return UNKNOWN_RESULT;
  }
  return stop.exitStatus === null
    ? stop.result
    : `${stop.result}, exit status ${String(stop.exitStatus)}`;
};

// One stop as a row of the history.
export const stopRow = (stop: ServiceStop, now: number): StopRow => {
  const stoppedAt = Date.parse(stop.stoppedAt);
  const lateBy = Date.parse(stop.receivedAt) - Date.parse(stop.sentAt);
  return {
    details: [
      { label: 'Stopped', value: [clockSecondsAt(stoppedAt)] },
      {
        label: 'Ran again',
        value:
          stop.startedAt === null
            ? [stop.ongoing ? 'Still down' : 'Not known']
            : [clockSecondsAt(Date.parse(stop.startedAt))],
      },
      { label: 'Result', value: [resultDetail(stop)] },
      { label: 'Restarts', value: [String(stop.restarts)] },
      { label: 'Sent', value: [clockSecondsAt(Date.parse(stop.sentAt))] },
      { label: 'Received', value: [clockSecondsAt(Date.parse(stop.receivedAt)), ' (Hub clock)'] },
    ],
    dot: dotOf(stop),
    duration: durationOf(stop, now),
    failure: isFailure(stop),
    late: lateBy > LATE_MS ? formatSpanShort(lateBy) : undefined,
    restarts: stop.restarts > 0 ? plural(stop.restarts, 'restart', 'restarts') : undefined,
    stoppedAt,
    title: stillDown(stop) ? ['Still down since ', whenAt(stoppedAt, now)] : [resultWords(stop)],
  };
};

// A row of the history: a stop, or a Service down Condition raised, with why
// and how long the Service was down, or cleared.
export type HistoryRow =
  | { at: number; kind: 'stop'; stop: StopRow }
  | { at: number; condition: string; duration: string; kind: 'downRaised'; reason: string }
  | { at: number; condition: string; kind: 'downCleared' };

const downRow = (
  down: ServiceDownTransition,
  downs: readonly ServiceDownTransition[],
  now: number,
): HistoryRow => {
  if (down.kind === 'cleared') {
    return { at: down.at, condition: down.condition, kind: 'downCleared' };
  }
  const cleared = downs.find(
    (found) => found.kind === 'cleared' && found.condition === down.condition,
  );
  return {
    at: down.at,
    condition: down.condition,
    duration:
      cleared === undefined
        ? formatSpanShort(Math.max(0, now - down.at))
        : formatSpan(Math.max(0, cleared.at - down.at)),
    kind: 'downRaised',
    reason: down.reason,
  };
};

// The stops and the Service down raises and clears as one history, newest
// first. Transitions at the same time keep the later recorded first, since the
// Hub's clock can step back.
export const historyRows = (
  stops: readonly ServiceStop[],
  downs: readonly ServiceDownTransition[],
  now: number,
): HistoryRow[] =>
  [
    ...downs.toReversed().map((down) => downRow(down, downs, now)),
    ...stops.map((stop): HistoryRow => {
      const row = stopRow(stop, now);
      return { at: row.stoppedAt, kind: 'stop', stop: row };
    }),
  ].toSorted((a, b) => b.at - a.at);

// The rows the history shows: the newest HISTORY_LIMIT until asked for all,
// and how many more there are.
export const listedRows = <Row>(
  rows: readonly Row[],
  all: boolean,
): { hidden: number; shown: readonly Row[] } =>
  all || rows.length <= HISTORY_LIMIT
    ? { hidden: 0, shown: rows }
    : { hidden: rows.length - HISTORY_LIMIT, shown: rows.slice(0, HISTORY_LIMIT) };

// The stops that began in the 90 days the summary counts and the strip draws.
// A stop still under way from before them stays in the history but not here.
const inWindow = (stops: readonly ServiceStop[], now: number) =>
  stops.filter((stop) => Date.parse(stop.stoppedAt) >= now - WINDOW_MS);

// How many stops fall in the 90 days, and in the last 24 hours.
export const stopSummary = (
  stops: readonly ServiceStop[],
  now: number,
): { last24h: number; total: number } => {
  const found = inWindow(stops, now);
  return {
    last24h: found.filter((stop) => Date.parse(stop.stoppedAt) > now - DAY_MS).length,
    total: found.length,
  };
};

// A stop on the strip: how far across the 90 days, in percent, and how tall.
export type Tick = { failure: boolean; height: number; left: number; stoppedAt: number };

export const stripTicks = (stops: readonly ServiceStop[], now: number): Tick[] =>
  inWindow(stops, now).map((stop) => {
    const stoppedAt = Date.parse(stop.stoppedAt);
    const capped = Math.min(stop.restarts, TICK_RESTARTS_CAP);
    return {
      failure: isFailure(stop),
      height: TICK_BASE + ((100 - TICK_BASE) * capped) / TICK_RESTARTS_CAP,
      left: Math.min(100, Math.max(0, xPercent(stoppedAt, { from: now - WINDOW_MS, to: now }))),
      stoppedAt,
    };
  });

// The instants the strip's axis labels: the window's start, middle, and end.
export const stripAxis = (now: number): [number, number, number] => [
  now - WINDOW_MS,
  now - WINDOW_MS / 2,
  now,
];

// How long ago the Hub last took a stop, or undefined when it holds none.
export const newestReceived = (stops: readonly ServiceStop[], now: number): string | undefined => {
  const newest = Math.max(...stops.map((stop) => Date.parse(stop.receivedAt)));
  if (!Number.isFinite(newest)) {
    return undefined;
  }
  const ago = Math.max(0, now - newest);
  return ago < MINUTE_MS ? 'just now' : `${formatSpanShort(ago)} ago`;
};

// "systemd · web.service": the supervisor and where it holds the Service.
export const supervisorLine = (
  supervisor: string,
  unit: string | undefined,
): string | undefined => {
  const parts = [
    supervisor === 'none' ? undefined : (SUPERVISOR_NAMES[supervisor] ?? supervisor),
    unit,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
};
