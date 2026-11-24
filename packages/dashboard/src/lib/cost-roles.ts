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

export function costClassLabel(costClass: CostClass): string {
  return classLabels[costClass];
}

/** The color that marks a class wherever the split is drawn. */
export function costClassColor(costClass: CostClass): string {
  return classColors[costClass];
}

/**
 * A conversation's role as one line: `review · breaker`, `review · seat
 * unknown`, or the role alone. Null when the conversation has no role.
 */
export function roleText(role: string | null, seat: string | null): string | null {
  if (role === null) {
    return null;
  }
  if (role !== 'review') {
    return role;
  }
  return `review · ${seat ?? 'seat unknown'}`;
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
