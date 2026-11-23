// What the Activity page says: the changes filtered, merged into lines, and
// each line put into words.

import { CONDITION_KIND_NAMES, conditionSubject } from '@heimdall/schema';
import type { ConditionLevel } from '@heimdall/schema';

import { ACTIVITY_KINDS, isActivityRange } from '../server/activity-types.ts';
import type {
  ActivityEvent,
  ActivityKind,
  ActivityRange,
  AlertActivity,
  ConditionActivity,
} from '../server/activity-types.ts';
import { pinFromSearch } from './activity-moment.ts';
import { knownValues, stringList } from './filter-search.ts';
import { aheadAt, joinPhrases } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { stopWords } from './stop-words.ts';
import { formatSpan } from './time.ts';

// The grouping rule: changes on one System merge into one line while each
// falls within this long of the first change of the line.
export const GROUP_WINDOW_MS = 2 * 60_000;

// The range Activity opens on.
export const DEFAULT_ACTIVITY_RANGE: ActivityRange = '7d';

export type ActivityLine = {
  // The line's changes, the one that leads its sentence first.
  events: ActivityEvent[];
  // The time of the change that leads its sentence.
  at: number;
  system: string;
};

// Which change leads a merged line's sentence: lower leads.
const LEAD_RANK: Record<ActivityKind, number> = {
  alert: 4,
  condition: 0,
  drift: 3,
  stop: 2,
  version: 1,
};

const byLead = (a: ActivityEvent, b: ActivityEvent) =>
  LEAD_RANK[a.kind] - LEAD_RANK[b.kind] || b.at - a.at;

// A run comes in the order its changes happened. Changes at the same moment
// keep that order, except that one Condition occurrence's changes at that
// moment take the place of its first there and the later leads, so the line
// tells what the Condition became.
const lineOf = (run: readonly ActivityEvent[]): ActivityLine => {
  const first = new Map<string, number>();
  const keyed = run.map((event, index) => {
    const occurrence =
      event.kind === 'condition' || event.kind === 'drift'
        ? `${String(event.at)}|${event.conditionId}`
        : undefined;
    if (occurrence !== undefined && !first.has(occurrence)) {
      first.set(occurrence, index);
    }
    return {
      event,
      index,
      place: occurrence === undefined ? index : (first.get(occurrence) ?? index),
    };
  });
  const events = keyed
    .toSorted((a, b) => byLead(a.event, b.event) || a.place - b.place || b.index - a.index)
    .map(({ event }) => event);
  const [lead] = events;
  return { at: lead?.at ?? 0, events, system: lead?.system ?? '' };
};

// The changes merged into lines under the grouping rule, newest lead first.
export const groupActivity = (events: readonly ActivityEvent[]): ActivityLine[] => {
  const lines: ActivityLine[] = [];
  for (const own of Map.groupBy(events, (event) => event.system).values()) {
    let run: ActivityEvent[] = [];
    for (const event of own.toSorted((a, b) => a.at - b.at)) {
      const [first] = run;
      if (first !== undefined && event.at - first.at > GROUP_WINDOW_MS) {
        lines.push(lineOf(run));
        run = [];
      }
      run.push(event);
    }
    if (run.length > 0) {
      lines.push(lineOf(run));
    }
  }
  return lines.toSorted((a, b) => b.at - a.at || a.system.localeCompare(b.system));
};

export type ActivityFilters = { kind?: ActivityKind | undefined; system?: string | undefined };

const matches = (event: ActivityEvent, filters: ActivityFilters, skip?: 'kind' | 'system') =>
  (skip === 'kind' || filters.kind === undefined || event.kind === filters.kind) &&
  (skip === 'system' || filters.system === undefined || event.system === filters.system);

// The changes of the chosen kind and System; an unset filter keeps all.
export const filterActivity = (
  events: readonly ActivityEvent[],
  filters: ActivityFilters,
): ActivityEvent[] => events.filter((event) => matches(event, filters));

const lineCount = (kept: readonly ActivityEvent[]): number => groupActivity(kept).length;

// Each chip counts the lines it would show: its changes filtered by the other
// filter only, then merged by the grouping rule. `total` is the All chip's,
// the lines of every kind.
export const activityCounts = (events: readonly ActivityEvent[], filters: ActivityFilters) => {
  const kind: Record<ActivityKind, number> = {
    alert: 0,
    condition: 0,
    drift: 0,
    stop: 0,
    version: 0,
  };
  for (const each of ACTIVITY_KINDS) {
    kind[each] = lineCount(
      events.filter((event) => event.kind === each && matches(event, filters, 'kind')),
    );
  }
  const bySystem = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const group = bySystem.get(event.system);
    if (group === undefined) {
      bySystem.set(event.system, [event]);
    } else {
      group.push(event);
    }
  }
  const system: Record<string, number> = {};
  for (const [each, own] of bySystem) {
    system[each] = lineCount(own.filter((event) => matches(event, filters, 'system')));
  }
  return {
    kind,
    system,
    total: lineCount(events.filter((event) => matches(event, filters, 'kind'))),
  };
};

// The search parameters Activity keeps: a known kind, a known range, one
// System, and the moment pinned on the axis with the System it was pinned on.
export const activitySearch = (search: Record<string, unknown>) => {
  const pin = pinFromSearch(search);
  return {
    kind: knownValues(search.kind, ACTIVITY_KINDS)?.[0],
    pin: pin?.at,
    pinOn: pin?.system,
    range: isActivityRange(search.range) ? search.range : DEFAULT_ACTIVITY_RANGE,
    system: stringList(search.system)[0],
  };
};

// Where the retired Timeline address leads: Activity, keeping a System chosen.
export const timelineRedirect = (
  search: Record<string, unknown>,
): { search: { system?: string }; to: '/activity' } => {
  const system = stringList(search.system)[0];
  return { search: system === undefined ? {} : { system }, to: '/activity' };
};

export type LineWords = {
  // The alert sent for the lead's Condition, or the lead itself when it is an
  // alert: the line's alert-sent marker.
  alert: { at: number; recoveredAt: number | undefined } | undefined;
  // What the lead changed after its subject: "cleared", or the levels a
  // level change went between.
  change: string;
  // The lead's detail, then each other change in words of its own, an alert
  // with when its recovery went out.
  detail: Phrase;
  // The level pill, for a line led by a Condition.
  level: ConditionLevel | undefined;
  // The lead is still happening: it is its Condition's latest change and the
  // Condition is still open, its alert is open, or its Service is still
  // stopped.
  open: boolean;
  // A monospace subject after the title: the subject of a Condition or alert.
  subject: string;
  title: string;
};

const subjectOf = (event: AlertActivity | ConditionActivity) =>
  conditionSubject({ kind: event.condition, subject: event.subject });

const changeOf = (event: ConditionActivity): string => {
  switch (event.action) {
    case 'cleared': {
      return 'cleared';
    }
    case 'level_changed': {
      return `${event.previousLevel ?? ''} → ${event.level}`;
    }
    default: {
      return '';
    }
  }
};

const isOpen = (event: ActivityEvent): boolean => {
  switch (event.kind) {
    case 'stop': {
      return event.ongoing;
    }
    case 'alert': {
      return event.open;
    }
    case 'version': {
      return false;
    }
    default: {
      return event.open && event.action !== 'cleared';
    }
  }
};

// The words of a change that leads a line.
const sentence = (event: ActivityEvent): { detail: string; title: string } => {
  switch (event.kind) {
    case 'version': {
      return { detail: '', title: `${event.service} ${event.from} → ${event.to}` };
    }
    case 'stop': {
      return {
        detail: '',
        title: stopWords(event),
      };
    }
    case 'alert': {
      return { detail: '', title: `Alert sent for ${CONDITION_KIND_NAMES[event.condition]}` };
    }
    default: {
      const lasted =
        event.action === 'cleared' ? `cleared after ${formatSpan(event.at - event.raisedAt)}` : '';
      return {
        detail: [event.reason, lasted].filter((part) => part !== '').join(' · '),
        title: CONDITION_KIND_NAMES[event.condition],
      };
    }
  }
};

// The words of a change that follows the lead in a line: whole enough to
// stand alone, with its subject, a Condition's level and, on its Condition's
// latest change, whether it is still open, and when an alert's recovery went
// out.
const phrase = (event: ActivityEvent): Phrase => {
  if (event.kind === 'version' || event.kind === 'stop') {
    return [sentence(event).title];
  }
  const named = [CONDITION_KIND_NAMES[event.condition], subjectOf(event)]
    .filter((part) => part !== '')
    .join(' ');
  if (event.kind === 'alert') {
    return event.recoveredAt === undefined
      ? [`Alert sent for ${named}`]
      : [`Alert sent for ${named}, recovery at `, aheadAt(event.recoveredAt, event.at)];
  }
  const change = changeOf(event);
  const state = [change === '' ? event.level : change, isOpen(event) ? 'open' : '']
    .filter((part) => part !== '')
    .join(', ');
  return [`${named} (${state})`];
};

// Whether `alert` was sent for the Condition `lead` is about.
const alertFor = (alert: AlertActivity, lead: ActivityEvent) =>
  alert === lead ||
  ((lead.kind === 'condition' || lead.kind === 'drift') &&
    alert.condition === lead.condition &&
    alert.subject === lead.subject);

// A line's sentence: its lead change's, then the detail of the lead and each
// other change it holds in words of its own. An alert sent for the lead's
// Condition shows as the alert-sent marker; any other alert is one of those
// other changes.
export const lineWords = (line: ActivityLine): LineWords => {
  const [lead, ...rest] = line.events;
  if (lead === undefined) {
    throw new Error('An Activity line holds at least one change.');
  }
  const { detail, title } = sentence(lead);
  const alert = line.events.find(
    (event): event is AlertActivity => event.kind === 'alert' && alertFor(event, lead),
  );
  const others = rest.filter((event) => event !== alert);
  const isCondition = lead.kind === 'condition' || lead.kind === 'drift';
  return {
    alert: alert === undefined ? undefined : { at: alert.at, recoveredAt: alert.recoveredAt },
    change: isCondition ? changeOf(lead) : '',
    detail: joinPhrases([[detail], ...others.map(phrase)], ' · '),
    level: isCondition ? lead.level : undefined,
    open: isOpen(lead),
    subject: isCondition || lead.kind === 'alert' ? subjectOf(lead) : '',
    title,
  };
};
