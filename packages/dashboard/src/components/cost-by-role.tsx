import { useId } from 'react';

import { costByRole, costByRoleNote, missedTagsSentence } from '../lib/cost-by-role.ts';
import type { ClassColumn, SeatRow } from '../lib/cost-by-role.ts';
import type { CostClass } from '../lib/cost-roles.ts';
import { formatCost } from '../lib/time.ts';
import type { MissedTags, RoleSplit } from '../server/role-split-types.ts';

// What each column says the class holds, under its amount.
const CLASS_NOTES: Partial<Record<CostClass, string>> = {
  delegated:
    'Every other role, such as implementation, research, and test, and subagents with no role above them',
  main: 'The main conversation of each Session with no role, usually one you started yourself',
};

function Swatch({ className, color }: { className: string; color: string }) {
  // `background`, not `background-color`, so the unknown seat's hatch draws.
  return <span aria-hidden="true" className={className} style={{ background: color }} />;
}

function Seats({ seats }: { seats: readonly SeatRow[] }) {
  return (
    <ul aria-label="Review by seat" className="mt-3 max-w-[300px] text-sm">
      {seats.map((seat) => (
        <li
          className="flex items-center gap-2 border-b border-border/60 py-1 last:border-b-0"
          key={seat.key}
        >
          <Swatch className="h-2 w-3.5 shrink-0 rounded-[2px]" color={seat.shade} />
          <span className="min-w-0 truncate" title={seat.name}>
            {seat.name}
          </span>
          <span className="ml-auto shrink-0 pl-3 font-semibold tabular-nums">
            {formatCost(seat.costUsd)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Column({ column, seats }: { column: ClassColumn; seats: readonly SeatRow[] }) {
  const note = CLASS_NOTES[column.class];
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Swatch className="size-2.5 shrink-0 rounded-[3px]" color={column.color} />
        {column.label}
      </p>
      <p className="mt-1 text-[22px] leading-tight font-semibold tabular-nums">
        {formatCost(column.costUsd)}
        {column.percent !== undefined && (
          <span className="ml-1.5 text-sm font-normal text-muted-foreground">
            {column.percent}%
          </span>
        )}
      </p>
      {note !== undefined && (
        <p className="mt-1.5 max-w-[300px] text-[13px] text-muted-foreground">{note}</p>
      )}
      {column.class === 'review' && seats.length > 0 && <Seats seats={seats} />}
    </div>
  );
}

/**
 * A period's list-price cost by role (ADR-0025): one strip of main, each
 * review seat, then delegated, and a column for each class with the review
 * seats listed in the strip's order. Given `missedTags`, it closes with how
 * many Sessions with a role missed their session tag. The columns stack on a
 * phone.
 */
export function CostByRole({
  missedTags,
  periodName,
  split,
}: {
  // The period in running text ("in 30 days", "today") with its counts.
  missedTags?: { rangeText: string; tags: MissedTags } | undefined;
  // The period as the note beside the title names it: "30 days", "Today".
  periodName: string;
  split: RoleSplit;
}) {
  const headingId = useId();
  const view = costByRole(split);
  const sentence =
    missedTags === undefined
      ? undefined
      : missedTagsSentence(missedTags.tags, missedTags.rangeText);
  const stripLabel = view.columns
    .map(({ costUsd, label }) => `${label} ${formatCost(costUsd)}`)
    .join(', ');
  return (
    <section aria-labelledby={headingId} className="card-surface rounded-xl border p-4">
      <h2 className="flex flex-wrap items-baseline gap-x-3 text-base font-semibold" id={headingId}>
        Cost by role
        <span className="text-sm font-normal text-muted-foreground">
          {costByRoleNote(periodName, view.unpricedRequests)}
        </span>
      </h2>
      {view.strip.length > 0 && (
        <div
          aria-label={stripLabel}
          className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full"
          role="img"
        >
          {view.strip.map((segment) => (
            <span
              className="block h-full min-w-0.5"
              key={segment.key}
              style={{ background: segment.color, width: `${String(segment.widthPercent)}%` }}
              title={segment.label}
            />
          ))}
        </div>
      )}
      <div className="mt-4 grid gap-5 md:grid-cols-3 md:gap-6">
        {view.columns.map((column) => (
          <Column column={column} key={column.class} seats={view.seats} />
        ))}
      </div>
      {sentence !== undefined && (
        <p className="mt-4 flex items-baseline gap-2.5 border-t border-border/60 pt-3 text-sm">
          {sentence.warn && (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 translate-y-[-1px] rounded-full bg-status-warning"
            />
          )}
          <span className={sentence.warn ? undefined : 'text-muted-foreground'}>
            {sentence.lead !== '' && <b className="font-semibold">{sentence.lead}</b>}
            {sentence.rest}
          </span>
        </p>
      )}
    </section>
  );
}
