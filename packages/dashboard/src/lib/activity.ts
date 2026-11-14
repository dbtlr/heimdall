// What the Activity page says: the changes filtered, merged into lines, and
// each line put into words.

import { CONDITION_KIND_NAMES } from '@heimdall/schema';
import type { ConditionLevel } from '@heimdall/schema';

import { ACTIVITY_KINDS, isActivityRange } from '../server/activity-types.ts';
import type {
  ActivityEvent,
  ActivityKind,
  ActivityRange,
  AlertActivity,
} from '../server/activity-types.ts';
import { knownValues, stringList } from './filter-search.ts';
import { formatSpan } from './time.ts';

// The grouping rule: changes on one System merge into one line while each
// falls within this long of the first change of the line.
export const GROUP_WINDOW_MS = 2 * 60_000;

// The range Activity opens on.
export const DEFAULT_ACTIVITY_RANGE: ActivityRange = '7d';

export type ActivityLine = {
  // The line's changes, the one that leads its sentence first.
  events: ActivityEvent[];
  // The time of the line's newest change.
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

const lineOf = (run: readonly ActivityEvent[]): ActivityLine => {
  const [first] = run;
  return {
    at: Math.max(...run.map((event) => event.at)),
    events: run.toSorted(byLead),
    system: first?.system ?? '',
  };
};

// The changes merged into lines under the grouping rule, newest line first.
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

// Each kind and System chip counts the changes it would show, constrained by
// the other filter only.
export const activityCounts = (events: readonly ActivityEvent[], filters: ActivityFilters) => {
  const kind: Record<ActivityKind, number> = {
    alert: 0,
    condition: 0,
    drift: 0,
    stop: 0,
    version: 0,
  };
  const system: Record<string, number> = Object.fromEntries(
    events.map((event) => [event.system, 0]),
  );
  for (const event of events) {
    if (matches(event, filters, 'kind')) {
      kind[event.kind] += 1;
    }
    if (matches(event, filters, 'system')) {
      system[event.system] = (system[event.system] ?? 0) + 1;
    }
  }
  return { kind, system };
};

// The search parameters Activity keeps: a known kind, a known range, one System.
export const activitySearch = (search: Record<string, unknown>) => ({
  kind: knownValues(search.kind, ACTIVITY_KINDS)?.[0],
  range: isActivityRange(search.range) ? search.range : DEFAULT_ACTIVITY_RANGE,
  system: stringList(search.system)[0],
});

// Where the retired Timeline address leads: Activity, keeping a System chosen.
export const timelineRedirect = (
  search: Record<string, unknown>,
): { search: { system?: string }; to: '/activity' } => {
  const system = stringList(search.system)[0];
  return { search: system === undefined ? {} : { system }, to: '/activity' };
};

export type LineWords = {
  alert: { at: number; recoveredAt: number | undefined } | undefined;
  detail: string;
  // The level pill, for a line led by a Condition.
  level: ConditionLevel | undefined;
  // Still happening: an open Condition or alert, or a Service still stopped.
  open: boolean;
  // A monospace subject after the title: the subject of a Condition or alert.
  subject: string;
  title: string;
};

const sentence = (event: ActivityEvent): { detail: string; title: string } => {
  switch (event.kind) {
    case 'version': {
      return { detail: '', title: `${event.service} ${event.from} → ${event.to}` };
    }
    case 'stop': {
      return {
        detail: '',
        title: event.ongoing ? `${event.service} stopped` : `${event.service} restarted`,
      };
    }
    case 'alert': {
      return { detail: '', title: `Alert sent for ${CONDITION_KIND_NAMES[event.condition]}` };
    }
    default: {
      const name = CONDITION_KIND_NAMES[event.condition];
      const lasted =
        event.action === 'raised' && event.clearedAt !== undefined
          ? `cleared after ${formatSpan(event.clearedAt - event.at)}`
          : '';
      return {
        detail: [event.reason, lasted].filter((part) => part !== '').join(' · '),
        title: event.action === 'cleared' ? `${name} cleared` : name,
      };
    }
  }
};

// A line's sentence: its lead change's, the detail of the lead and the
// sentences of the other changes after it, and whether an alert was sent. An
// alert that merged into a line shows as the alert-sent marker, not a sentence.
export const lineWords = (line: ActivityLine): LineWords => {
  const [lead, ...rest] = line.events;
  if (lead === undefined) {
    throw new Error('An Activity line holds at least one change.');
  }
  const { detail, title } = sentence(lead);
  const alert = line.events.find((event): event is AlertActivity => event.kind === 'alert');
  const others = rest
    .filter((event) => event.kind !== 'alert')
    .map((event) => sentence(event).title);
  const isCondition = lead.kind === 'condition' || lead.kind === 'drift';
  const conditionOpen = line.events.some(
    (event) =>
      (event.kind === 'condition' || event.kind === 'drift') &&
      event.action === 'raised' &&
      event.clearedAt === undefined,
  );
  return {
    alert: alert === undefined ? undefined : { at: alert.at, recoveredAt: alert.recoveredAt },
    detail: [detail, ...others].filter((part) => part !== '').join(' · '),
    level: isCondition ? lead.level : undefined,
    open:
      conditionOpen ||
      line.events.some(
        (event) =>
          (event.kind === 'stop' && event.ongoing) || (event.kind === 'alert' && event.open),
      ),
    subject: isCondition || lead.kind === 'alert' ? lead.subject : '',
    title,
  };
};
