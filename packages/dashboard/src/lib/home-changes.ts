// What Home's What changed card says: the changes of the last day grouped
// across Systems, so one release rolled out to six Systems reads as one line.

import { CONDITION_KIND_NAMES, conditionSubject } from '@heimdall/schema';

import { CHANGE_WINDOW_MS } from '../server/home-types.ts';
import type { Change, ChangeGroup } from '../server/home-types.ts';

// How many groups the card lists.
export const CHANGES_SHOWN = 5;

type Stop = Extract<Change, { kind: 'stop' }>;
type Version = Extract<Change, { kind: 'version' }>;

// A change with the stops a version change folded in, by System.
type Folded = { change: Change; stops: number };

// What changes must share to group: their kind, their Service or Condition
// and subject, and their version transition, action, or whether the stop is
// ongoing.
const groupKey = (change: Change): string => {
  switch (change.kind) {
    case 'version': {
      return JSON.stringify([change.kind, change.service, change.from, change.to]);
    }
    case 'stop': {
      return JSON.stringify([change.kind, change.service, change.ongoing]);
    }
    default: {
      return JSON.stringify([change.kind, change.condition, change.subject, change.action]);
    }
  }
};

// The version change of the same Service on the same System nearest `stop`,
// within the window, if any.
const versionFor = (stop: Stop, versions: readonly Version[]): Version | undefined =>
  versions
    .filter(
      (version) =>
        version.system === stop.system &&
        version.service === stop.service &&
        Math.abs(version.at - stop.at) <= CHANGE_WINDOW_MS,
    )
    .toSorted((a, b) => Math.abs(a.at - stop.at) - Math.abs(b.at - stop.at))[0];

// Each change, a version change carrying the stops of its own Service on its
// own System within the window, and only the stops no version change took. A
// stop still ongoing is no restart, so no version change takes it.
const foldStops = (changes: readonly Change[]): Folded[] => {
  const versions = changes.filter((change): change is Version => change.kind === 'version');
  const folded = new Map<Change, number>(versions.map((version) => [version, 0]));
  const rest: Folded[] = [];
  for (const change of changes) {
    if (change.kind === 'stop') {
      const version = change.ongoing ? undefined : versionFor(change, versions);
      if (version === undefined) {
        rest.push({ change, stops: 1 });
      } else {
        folded.set(version, (folded.get(version) ?? 0) + 1);
      }
    } else if (change.kind === 'condition') {
      rest.push({ change, stops: 0 });
    }
  }
  return [...[...folded].map(([change, stops]) => ({ change, stops })), ...rest];
};

// One run of changes that share a key, each within the window of the first.
const groupOf = (run: readonly Folded[]): ChangeGroup => {
  const stops: Record<string, number> = {};
  for (const { change, stops: count } of run) {
    stops[change.system] = (stops[change.system] ?? 0) + count;
  }
  const newest = run.reduce((latest, item) => (item.change.at > latest.change.at ? item : latest));
  return {
    at: newest.change.at,
    change: newest.change,
    stops,
    systems: Object.keys(stops).toSorted((a, b) => a.localeCompare(b)),
  };
};

// The changes grouped: a version change folds the stops of its Service on its
// System within CHANGE_WINDOW_MS, then changes with the same kind, Service or
// Condition and subject, and version transition or action group across
// Systems while each falls within CHANGE_WINDOW_MS of the group's first. The
// newest `limit` groups, newest first, each timed by its newest change.
export const groupChanges = (changes: readonly Change[], limit = CHANGES_SHOWN): ChangeGroup[] => {
  const byKey = Map.groupBy(foldStops(changes), ({ change }) => groupKey(change));
  const groups: ChangeGroup[] = [];
  for (const items of byKey.values()) {
    let run: Folded[] = [];
    for (const item of items.toSorted((a, b) => a.change.at - b.change.at)) {
      const [first] = run;
      if (first !== undefined && item.change.at - first.change.at > CHANGE_WINDOW_MS) {
        groups.push(groupOf(run));
        run = [];
      }
      run.push(item);
    }
    if (run.length > 0) {
      groups.push(groupOf(run));
    }
  }
  return groups
    .toSorted((a, b) => b.at - a.at || groupKey(a.change).localeCompare(groupKey(b.change)))
    .slice(0, limit);
};

// A group's id among those groupChanges returns: its key and its time. Runs of
// one key never overlap, so no two of them end at the same change.
export const changeGroupId = (group: ChangeGroup): string =>
  `${groupKey(group.change)}@${String(group.at)}`;

// "server-1", "server-1 and server-2", or "6 Systems".
const systemsWords = (systems: readonly string[]): string => {
  const [first, second] = systems;
  if (systems.length > 2 || first === undefined) {
    return `${String(systems.length)} Systems`;
  }
  return second === undefined ? first : `${first} and ${second}`;
};

const total = (group: ChangeGroup) =>
  Object.values(group.stops).reduce((sum, count) => sum + count, 0);

// How often a version change's Systems restarted: once each, or the total.
const restartWords = (group: ChangeGroup): string | undefined => {
  const stops = total(group);
  if (stops === 0) {
    return undefined;
  }
  if (group.systems.every((system) => group.stops[system] === 1)) {
    return group.systems.length === 1 ? 'restarted once' : 'restarted once each';
  }
  return `${String(stops)} ${stops === 1 ? 'restart' : 'restarts'}`;
};

// The group's line and the line under it, which is a subject in monospace
// when `mono` holds.
export const changeWords = (
  group: ChangeGroup,
): { detail: string; mono: boolean; title: string } => {
  const { change, systems } = group;
  const where = systemsWords(systems);
  switch (change.kind) {
    case 'version': {
      const restarts = restartWords(group);
      return {
        detail: restarts === undefined ? where : `${where}, ${restarts}`,
        mono: false,
        title: `${change.service} ${change.from} → ${change.to}`,
      };
    }
    case 'stop': {
      if (change.ongoing) {
        return {
          detail: `${where}, still stopped`,
          mono: false,
          title: `${change.service} stopped`,
        };
      }
      const stops = total(group);
      return {
        detail: where,
        mono: false,
        title: `${change.service} restarted${stops > systems.length ? ` ${String(stops)} times` : ''}`,
      };
    }
    default: {
      const subject = conditionSubject({ kind: change.condition, subject: change.subject });
      const name = `${CONDITION_KIND_NAMES[change.condition]} ${change.action}`;
      if (systems.length === 1) {
        return { detail: subject, mono: subject !== '', title: `${name} on ${change.system}` };
      }
      return {
        detail: subject === '' ? where : `${where} · ${subject}`,
        mono: false,
        title: name,
      };
    }
  }
};

// Where a group leads: a Service change on one System to its Service page, on
// several to the Services page for those Systems; a Condition change on one
// System to its Condition page, on several to the Timeline.
export type ChangeLink =
  | { service: string; system: string; to: 'service' }
  | { systems: string[]; to: 'services' }
  | { id: string; system: string; to: 'condition' }
  | { to: 'activity' };

export const changeLink = ({ change, systems }: ChangeGroup): ChangeLink => {
  if (change.kind === 'condition') {
    return systems.length === 1
      ? { id: change.conditionId, system: change.system, to: 'condition' }
      : { to: 'activity' };
  }
  return systems.length === 1
    ? { service: change.service, system: change.system, to: 'service' }
    : { systems, to: 'services' };
};
