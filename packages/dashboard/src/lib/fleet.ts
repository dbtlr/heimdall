import type { ConditionLevel } from '@heimdall/schema';

import type { Attention } from '../server/attention-types.ts';
import type { FleetOverview, Lane } from '../server/fleet-overview-types.ts';
import { DELIVERY_FAILING_SHOWN_AFTER_MS, QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';

const LEVEL_RANK: Record<ConditionLevel, number> = { alert: 0, note: 2, warning: 1 };

export const levelCounts = (items: readonly Attention[]) => ({
  alert: items.filter((item) => item.level === 'alert').length,
  note: items.filter((item) => item.level === 'note').length,
  warning: items.filter((item) => item.level === 'warning').length,
});

export const worstActionLevel = (
  counts: ReturnType<typeof levelCounts>,
): 'alert' | 'warning' | undefined => {
  if (counts.alert > 0) {
    return 'alert';
  }
  if (counts.warning > 0) {
    return 'warning';
  }
  return undefined;
};

// Freshness qualifies the evidence; it never changes the Hub's judgment.
export const fleetAttention = (items: readonly Attention[]) => {
  const paired = items.filter((item) => !item.unpaired);
  const conditions = paired.toSorted(
    (a, b) =>
      (a.level === undefined ? 3 : LEVEL_RANK[a.level]) -
        (b.level === undefined ? 3 : LEVEL_RANK[b.level]) ||
      b.firstDetected - a.firstDetected ||
      a.system.localeCompare(b.system) ||
      a.kind.localeCompare(b.kind) ||
      a.subject.localeCompare(b.subject),
  );
  return {
    counts: levelCounts(conditions),
    evidence: conditions.filter((item) => item.level === undefined),
    needsYou: conditions.filter((item) => item.level === 'alert' || item.level === 'warning'),
    notes: conditions.filter((item) => item.level === 'note'),
  };
};

export const levelCountsText = (counts: ReturnType<typeof fleetAttention>['counts']) =>
  (['alert', 'warning', 'note'] satisfies ConditionLevel[])
    .filter((level) => counts[level] > 0)
    .map((level) => `${String(counts[level])} ${level}${counts[level] === 1 ? '' : 's'}`)
    .join(', ');

export const isAsleep = (lane: Pick<Lane, 'sleeps' | 'lastSeenAt'>, now: number) =>
  lane.sleeps && lane.lastSeenAt !== undefined && now - lane.lastSeenAt > QUIET_AFTER_MS;

// When delivery began failing, once that run is old enough to show; otherwise undefined.
export const deliveryFailingShown = ({
  deliveryFailingSince,
  now,
}: Pick<FleetOverview, 'deliveryFailingSince' | 'now'>) =>
  deliveryFailingSince !== undefined &&
  now - deliveryFailingSince >= DELIVERY_FAILING_SHOWN_AFTER_MS
    ? deliveryFailingSince
    : undefined;

export const fleetVerdict = (items: readonly Attention[]) => {
  const { needsYou, counts } = fleetAttention(items);
  const worst = counts.alert > 0 ? 'alert' : 'warning';
  const names = [
    ...new Set(needsYou.filter((item) => item.level === worst).map((item) => item.system)),
  ];
  const who = names.length === 1 ? names[0] : `${String(names.length)} Systems`;
  return needsYou.length === 0
    ? 'No Conditions need action'
    : `${who} ${names.length === 1 ? 'needs' : 'need'} you ${worst === 'alert' ? 'now' : 'this week'}`;
};
