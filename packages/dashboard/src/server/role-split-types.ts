import type { CostClass } from '../lib/cost-roles.ts';
import type { PeriodTotals } from './agents-overview-types.ts';

// What one review seat cost over a period; `seat` is null for an unknown seat.
export type SeatTotals = PeriodTotals & { seat: string | null };

// A period's list-price cost split three ways by role (ADR-0025): each class's
// totals, and the review class again by seat, in no set order. The classes sum
// to the period's own totals.
export type RoleSplit = {
  classes: Record<CostClass, PeriodTotals>;
  seats: SeatTotals[];
};

// The period's Sessions whose role came from a session tag or T3's preamble,
// and how many of those took it from the preamble because the brief had no tag.
export type MissedTags = { missed: number; withRole: number };
