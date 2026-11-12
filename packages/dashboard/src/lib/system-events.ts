// What the System page's Conditions and changes lane says: each Condition
// open in the window and each Service change as one line of events, and the
// rows the Condition spans stack on.

import { CONDITION_KIND_NAMES, conditionSubject } from '@heimdall/schema';
import type { ConditionLevel } from '@heimdall/schema';

import type { ConditionMark } from '../server/fleet-overview-types.ts';
import type { Change } from '../server/home-types.ts';
import { changeWords, groupChanges } from './home-changes.ts';
import type { Window } from './time.ts';

export type SystemEvent =
  | { at: number; end: number | undefined; kind: 'condition'; level: ConditionLevel; text: string }
  | { at: number; kind: 'change'; text: string };

const LEVEL_RANK: Record<ConditionLevel, number> = { alert: 2, note: 0, warning: 1 };

// The highest level a Condition reached, which its current level alone does
// not say once it has been cleared or has eased.
export const peakLevel = (mark: ConditionMark): ConditionLevel =>
  mark.transitions.reduce<ConditionLevel>(
    (peak, { level }) => (LEVEL_RANK[level] > LEVEL_RANK[peak] ? level : peak),
    mark.level,
  );

// Conditions a note-level Pending update or Reboot required, and Service
// restarted, which the Maintenance line and the Service changes show instead.
const shownElsewhere = (mark: ConditionMark): boolean =>
  mark.kind === 'service_restarted' ||
  ((mark.kind === 'pending_update' || mark.kind === 'reboot_required') &&
    peakLevel(mark) === 'note');

// The Conditions of `marks` that belong on the lane, each open at some time in
// the window.
export const laneConditions = (marks: readonly ConditionMark[], window: Window): ConditionMark[] =>
  marks.filter(
    (mark) =>
      !shownElsewhere(mark) &&
      mark.raisedAt <= window.to &&
      (mark.clearedAt ?? window.to) >= window.from,
  );

// The Conditions open in the window, and the Service changes in it, as events
// oldest first. A Condition raised or cleared is its span, not a second event.
export const systemEvents = (
  { changes, conditions }: { changes: readonly Change[]; conditions: readonly ConditionMark[] },
  window: Window,
): SystemEvent[] => {
  const spans = laneConditions(conditions, window).map((mark): SystemEvent => {
    const level = peakLevel(mark);
    const subject = mark.subject === '' ? '' : ` ${conditionSubject(mark)}`;
    return {
      at: mark.raisedAt,
      end: mark.clearedAt,
      kind: 'condition',
      level,
      text: `${CONDITION_KIND_NAMES[mark.kind]}${subject}, ${level}`,
    };
  });
  const moves = groupChanges(
    changes.filter(({ kind }) => kind !== 'condition'),
    Number.POSITIVE_INFINITY,
  ).map((group): SystemEvent => {
    const restarted =
      group.change.kind === 'version' && Object.values(group.stops).some((count) => count > 0);
    return {
      at: group.at,
      kind: 'change',
      text: `${changeWords(group).title}${restarted ? ', restarted' : ''}`,
    };
  });
  return [...spans, ...moves].toSorted((a, b) => a.at - b.at);
};

// The stretches of a Condition's span at each level it held, from its raise to
// `end`, where it was cleared or the window ends.
export const levelSegments = (
  mark: ConditionMark,
  end: number,
): { end: number; level: ConditionLevel; start: number }[] =>
  mark.transitions.length === 0
    ? [{ end, level: mark.level, start: mark.raisedAt }]
    : mark.transitions.flatMap(({ at, kind, level }, index) =>
        kind === 'cleared'
          ? []
          : [{ end: mark.transitions[index + 1]?.at ?? end, level, start: at }],
      );

// The row each span takes when overlapping spans may not share one: the first
// row whose last span has ended by the time this one starts.
export const packRows = (spans: readonly { end: number; start: number }[]): number[] => {
  const ends: number[] = [];
  return spans.map(({ end, start }) => {
    const free = ends.findIndex((last) => last <= start);
    const row = free === -1 ? ends.length : free;
    ends[row] = end;
    return row;
  });
};
