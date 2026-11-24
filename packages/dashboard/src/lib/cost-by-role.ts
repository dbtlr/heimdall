import type { PeriodTotals } from '../server/agents-overview-types.ts';
import type { MissedTags, RoleSplit } from '../server/role-split-types.ts';
import { costClassColor, costClassLabel, shadeSeats } from './cost-roles.ts';
import type { CostClass } from './cost-roles.ts';

/** One review seat's row in the Review column, in the strip's order. */
export type SeatRow = {
  costUsd: number;
  key: string;
  name: string;
  // A CSS background: a color, or for an unknown seat the hatch.
  shade: string;
};

/** One of the three columns under the strip. */
export type ClassColumn = {
  class: CostClass;
  color: string;
  costUsd: number;
  label: string;
  // The class's share of the priced cost, rounded; undefined when nothing was priced.
  percent: number | undefined;
};

/** One segment of the 100% strip, as a share of the priced cost. */
export type StripSegment = { color: string; key: string; label: string; widthPercent: number };

export type CostByRoleView = {
  columns: ClassColumn[];
  // Empty when the period has no review cost.
  seats: SeatRow[];
  // Empty when nothing in the period was priced.
  strip: StripSegment[];
  totalUsd: number;
  unpricedRequests: number;
};

/** Past this many known seats, the list keeps one fewer and rolls the rest into one row. */
export const SEATS_LISTED = 6;

const CLASSES: CostClass[] = ['main', 'review', 'delegated'];

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

// The seats in the order shadeSeats gives them. Past SEATS_LISTED known seats,
// the costliest SEATS_LISTED - 1 stay and the rest share one "n more seats" row
// in the shared shade, so the list never ends in a row for a single seat; the
// unknown seat stays last.
const seatRows = (seats: RoleSplit['seats']): SeatRow[] => {
  const shaded = shadeSeats(seats.map((seat) => ({ cost: seat.pricedCostUsd, seat: seat.seat })));
  const known = shaded.filter((row) => row.seat !== null);
  const unknown = shaded.filter((row) => row.seat === null);
  const kept = known.length > SEATS_LISTED ? known.slice(0, SEATS_LISTED - 1) : known;
  const rolled = known.slice(kept.length);
  return [
    ...kept.map((row) => ({
      costUsd: row.cost,
      key: `seat:${row.seat ?? ''}`,
      name: row.seat ?? '',
      shade: row.shade,
    })),
    ...(rolled.length === 0
      ? []
      : [
          {
            costUsd: rolled.reduce((sum, row) => sum + row.cost, 0),
            key: 'more',
            name: `${String(rolled.length)} more seats`,
            shade: 'var(--review-other)',
          },
        ]),
    ...unknown.map((row) => ({
      costUsd: row.cost,
      key: 'unknown',
      name: 'seat unknown',
      shade: row.shade,
    })),
  ];
};

const sum = (totals: readonly PeriodTotals[]) =>
  totals.reduce((all, { pricedCostUsd }) => all + pricedCostUsd, 0);

/**
 * What the Cost by role card draws for a split: a strip of main, each review
 * seat, then delegated, as shares of the priced cost; the three columns; and
 * the seats in the strip's order. A class or seat with no priced cost has no
 * segment, and a split with nothing priced has no strip.
 */
export function costByRole(split: RoleSplit): CostByRoleView {
  const { classes } = split;
  const totalUsd = sum(Object.values(classes));
  const share = (costUsd: number) => (totalUsd > 0 ? (costUsd / totalUsd) * 100 : 0);
  const seats = seatRows(split.seats);
  const columns = CLASSES.map((costClass) => ({
    class: costClass,
    color: costClassColor(costClass),
    costUsd: classes[costClass].pricedCostUsd,
    label: costClassLabel(costClass),
    percent: totalUsd > 0 ? Math.round(share(classes[costClass].pricedCostUsd)) : undefined,
  }));
  const segments: StripSegment[] = [
    {
      color: costClassColor('main'),
      key: 'main',
      label: 'Main',
      widthPercent: share(classes.main.pricedCostUsd),
    },
    ...seats.map((seat) => ({
      color: seat.shade,
      key: seat.key,
      label: `Review · ${seat.name}`,
      widthPercent: share(seat.costUsd),
    })),
    {
      color: costClassColor('delegated'),
      key: 'delegated',
      label: 'Delegated',
      widthPercent: share(classes.delegated.pricedCostUsd),
    },
  ];
  return {
    columns,
    seats,
    strip: totalUsd > 0 ? segments.filter(({ widthPercent }) => widthPercent > 0) : [],
    totalUsd,
    unpricedRequests: Object.values(classes).reduce(
      (all, { unpricedRequests }) => all + unpricedRequests,
      0,
    ),
  };
}

/** The note beside the card's title: the period, and any requests left unpriced. */
export function costByRoleNote(periodName: string, unpricedRequests: number): string {
  const note = `${periodName}, at list price`;
  return unpricedRequests > 0
    ? `${note} · at least, ${plural(unpricedRequests, 'request', 'requests')} unpriced`
    : note;
}

/**
 * The card's closing sentence about Sessions with a role that missed their
 * session tag: `lead` is set apart in bold, and `warn` marks a miss.
 */
export function missedTagsSentence(
  { missed, withRole }: MissedTags,
  rangeText: string,
): { lead: string; rest: string; warn: boolean } {
  if (withRole === 0) {
    return { lead: '', rest: `No Session with a role had a request ${rangeText}.`, warn: false };
  }
  const sessions = withRole === 1 ? 'Session' : 'Sessions';
  if (missed === 0) {
    return {
      lead: '',
      rest:
        withRole === 1
          ? 'The one Session with a role had a session tag.'
          : `All ${String(withRole)} ${sessions} with a role had a session tag.`,
      warn: false,
    };
  }
  const its = missed === 1 ? 'its' : 'their';
  return {
    lead: `${String(missed)} of ${String(withRole)}`,
    rest: ` ${sessions} with a role had no session tag and took it from T3's preamble, so ${its} launcher and any review seat are unknown.`,
    warn: true,
  };
}
