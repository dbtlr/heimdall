// What a Service page says, as plain values the components only render: the
// table of its stops, and its history of Service down raises and clears and
// installed version changes and available updates, newest first. The times that
// depend on the viewer's zone stay phrases, or take the zone as an argument.

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { SUPERVISOR_NAMES } from './recorded.ts';
import { downSpans, isDownStop, stopSpan } from './service-availability.ts';
import type { Install } from './service-installs.ts';
import type { UpstreamRelease } from './service-updates.ts';
import { formatSpan, formatSpanShort } from './time.ts';

// The history shows this many rows until asked for the older ones.
export const HISTORY_LIMIT = 6;

// A stop of the table: when it began, whether the Service was down or only
// restarted, how long, how it ended, and the restarts the supervisor made.
export type StopLine = {
  // How long it was down, or why that is not known.
  duration: string;
  // The Service down Condition was open over it, or it is still down.
  down: boolean;
  restarts: number;
  // The stop's result in words, for a still-down stop how long ago it began.
  result: Phrase;
  stoppedAt: number;
};

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

const durationOf = (stop: ServiceStop, now: number): string => {
  const stoppedAt = Date.parse(stop.stoppedAt);
  if (stop.startedAt !== null) {
    return formatSpan(Math.max(0, Date.parse(stop.startedAt) - stoppedAt));
  }
  return stop.ongoing ? formatSpanShort(Math.max(0, now - stoppedAt)) : 'End unknown';
};

// The stops as the table's lines, newest first.
export const stopLines = (
  stops: readonly ServiceStop[],
  downs: readonly ServiceDownTransition[],
  now: number,
): StopLine[] => {
  const spans = downSpans(downs, now);
  return stops
    .map((stop): StopLine => {
      const stillDown = stop.ongoing && stop.startedAt === null;
      return {
        down: isDownStop(stop, spans, now),
        duration: durationOf(stop, now),
        restarts: stop.restarts,
        result: stillDown
          ? ['Still down since ', whenAt(stopSpan(stop, now).from, now)]
          : [resultWords(stop)],
        stoppedAt: stopSpan(stop, now).from,
      };
    })
    .toSorted((a, b) => b.stoppedAt - a.stoppedAt);
};

// A row of the history: a Service down Condition raised, with why and how long
// the Service was down, or cleared, or a new installed version with the one it
// replaced, or an available update.
export type HistoryRow =
  | { at: number; kind: 'installed'; version: string; was: string }
  | { at: number; kind: 'update'; version: string }
  | { at: number; condition: string; duration: string; kind: 'downRaised'; reason: string }
  | { at: number; condition: string; kind: 'downCleared' };

// `clearedAt` holds when each cleared Service down Condition cleared, by id.
const downRow = (
  down: ServiceDownTransition,
  clearedAt: ReadonlyMap<string, number>,
  now: number,
): HistoryRow => {
  if (down.kind === 'cleared') {
    return { at: down.at, condition: down.condition, kind: 'downCleared' };
  }
  const cleared = clearedAt.get(down.condition);
  return {
    at: down.at,
    condition: down.condition,
    duration:
      cleared === undefined
        ? formatSpanShort(Math.max(0, now - down.at))
        : formatSpan(Math.max(0, cleared - down.at)),
    kind: 'downRaised',
    reason: down.reason,
  };
};

// The Service down raises and clears, and the installed version changes and
// available updates as one history, newest first. Transitions at the same time
// keep the later recorded first, since the Hub's clock can step back.
export const historyRows = (
  downs: readonly ServiceDownTransition[],
  installs: readonly Install[],
  updates: readonly UpstreamRelease[],
  now: number,
): HistoryRow[] => {
  const clearedAt = new Map(
    downs.filter(({ kind }) => kind === 'cleared').map(({ at, condition }) => [condition, at]),
  );
  return [
    ...downs.toReversed().map((down) => downRow(down, clearedAt, now)),
    ...installs.map((install): HistoryRow => ({ ...install, kind: 'installed' })),
    ...updates.map((update): HistoryRow => ({ ...update, kind: 'update' })),
  ].toSorted((a, b) => b.at - a.at);
};

// The rows a list shows: the newest HISTORY_LIMIT until asked for all, and how
// many more there are.
export const listedRows = <Row>(
  rows: readonly Row[],
  all: boolean,
): { hidden: number; shown: readonly Row[] } =>
  all || rows.length <= HISTORY_LIMIT
    ? { hidden: 0, shown: rows }
    : { hidden: rows.length - HISTORY_LIMIT, shown: rows.slice(0, HISTORY_LIMIT) };

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
