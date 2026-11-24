// Labels and colors for ADR-0025's cost split by role, shared by the Session,
// Agents, and project pages so a class reads the same everywhere it appears.
// A seat's shade is its cost rank within each list, so one seat can take a
// different shade in another list.

/** The three classes list-price cost splits into. */
export type CostClass = 'main' | 'review' | 'delegated';

const classLabels: Record<CostClass, string> = {
  delegated: 'Delegated',
  main: 'Main',
  review: 'Review',
};

const classColors: Record<CostClass, string> = {
  delegated: 'var(--series-1)',
  main: 'var(--plot)',
  review: 'var(--review-1)',
};

const COST_CLASSES: readonly CostClass[] = ['delegated', 'main', 'review'];

/** A role class read from the Hub's database, which must be one the dashboard knows. */
export function roleClassOf(value: string): CostClass {
  const known = COST_CLASSES.find((costClass) => costClass === value);
  if (known === undefined) {
    throw new Error(`The Hub holds a role class ${value}, which the dashboard does not know.`);
  }
  return known;
}

export function costClassLabel(costClass: CostClass): string {
  return classLabels[costClass];
}

/** The color that marks a class wherever the split is drawn. */
export function costClassColor(costClass: CostClass): string {
  return classColors[costClass];
}

/** A review's seat as shown: its name, or `seat unknown` when the tag named none. */
export function seatText(seat: string | null | undefined): string {
  return seat ?? 'seat unknown';
}

/**
 * A conversation's role as one line: `review · breaker`, `review · seat
 * unknown`, or the role alone. Null when the conversation has no role.
 */
export function roleText(role: string, seat: string | null): string;
export function roleText(role: string | null, seat: string | null): string | null;
export function roleText(role: string | null, seat: string | null): string | null {
  if (role === null) {
    return null;
  }
  if (role !== 'review') {
    return role;
  }
  return `review · ${seatText(seat)}`;
}

/** How many review seats get a shade of their own before the rest share one. */
const OWN_SHADES = 3;

/**
 * Orders review seats for a bar and its list, and gives each its shade.
 * Known seats come first, costliest first, ties by name; the three costliest
 * get their own shade and the rest share one. The unknown seat (null) comes
 * last, hatched.
 */
export function shadeSeats<T extends { seat: string | null; cost: number }>(
  rows: readonly T[],
): (T & { shade: string })[] {
  const known = rows
    .filter((row) => row.seat !== null)
    .toSorted((a, b) => b.cost - a.cost || (a.seat ?? '').localeCompare(b.seat ?? ''));
  const unknown = rows.filter((row) => row.seat === null);
  const shaded: (T & { shade: string })[] = [];
  for (const [index, row] of known.entries()) {
    const shade = index < OWN_SHADES ? `var(--review-${index + 1})` : 'var(--review-other)';
    shaded.push({ ...row, shade });
  }
  for (const row of unknown) {
    shaded.push({ ...row, shade: 'var(--review-unknown)' });
  }
  return shaded;
}

/** Past this many known seats, a seat list keeps one fewer and rolls the rest into one line. */
export const SEATS_LISTED = 6;

/** One line of a seat list: a seat, the cheapest seats rolled into one, or the unknown seat. */
export type SeatLine = {
  cost: number;
  // `seat:<name>`, `more`, or `unknown`.
  key: string;
  // The seat's name, `n more seats`, or `seat unknown`.
  name: string;
  // The seats the line stands for: one, or every seat it rolls up.
  seats: (string | null)[];
  shade: string;
};

/**
 * The seats as a list draws them, in {@link shadeSeats}' order. Past
 * {@link SEATS_LISTED} known seats, the costliest `SEATS_LISTED - 1` stay and
 * the rest share one `n more seats` line in the shared shade, so a list never
 * rolls up a single seat. The unknown seat always keeps its own line, last.
 */
export function listSeats(rows: readonly { seat: string | null; cost: number }[]): SeatLine[] {
  const shaded = shadeSeats(rows);
  const known = shaded.filter((row) => row.seat !== null);
  const unknown = shaded.filter((row) => row.seat === null);
  const kept = known.length > SEATS_LISTED ? known.slice(0, SEATS_LISTED - 1) : known;
  const rolled = known.slice(kept.length);
  return [
    ...kept.map((row) => ({
      cost: row.cost,
      key: `seat:${row.seat ?? ''}`,
      name: row.seat ?? '',
      seats: [row.seat],
      shade: row.shade,
    })),
    ...(rolled.length === 0
      ? []
      : [
          {
            cost: rolled.reduce((sum, row) => sum + row.cost, 0),
            key: 'more',
            name: `${String(rolled.length)} more seats`,
            seats: rolled.map((row) => row.seat),
            shade: 'var(--review-other)',
          },
        ]),
    ...unknown.map((row) => ({
      cost: row.cost,
      key: 'unknown',
      name: 'seat unknown',
      seats: [row.seat],
      shade: row.shade,
    })),
  ];
}
