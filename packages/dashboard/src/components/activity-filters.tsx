import { Link } from '@tanstack/react-router';

import { cn } from '../lib/utils.ts';
import { ACTIVITY_KINDS, ACTIVITY_RANGES } from '../server/activity-types.ts';
import type { ActivityKind, ActivityRange } from '../server/activity-types.ts';

export const KIND_NAMES: Record<ActivityKind, string> = {
  alert: 'Alerts sent',
  condition: 'Conditions',
  drift: 'Drift',
  stop: 'Service stops',
  version: 'Versions',
};

const RANGE_NAMES: Record<ActivityRange, string> = { '24h': '24 h', '30d': '30 d', '7d': '7 d' };

const CHIP = 'flex min-h-11 items-center rounded-full border px-3 text-sm';
const CHOSEN = 'border-select bg-select/15 text-select';

// A chip per kind, with a count of what it would show, and All with its own
// count of the lines every kind shows, which is not the kinds' sum when a line
// merges kinds; the kind lives in the URL, so a link to a kind shares it.
export function KindChips({
  counts,
  current,
}: {
  counts: { kind: Record<ActivityKind, number>; total: number };
  current: ActivityKind | undefined;
}) {
  return (
    <nav aria-label="Kind" className="flex flex-wrap gap-2">
      <Link
        aria-current={current === undefined ? 'page' : undefined}
        className={cn(CHIP, current === undefined ? CHOSEN : 'bg-secondary')}
        resetScroll={false}
        search={(previous) => ({ ...previous, kind: undefined })}
        to="."
      >
        All <span className="ml-1.5 text-xs tabular-nums">{counts.total}</span>
      </Link>
      {ACTIVITY_KINDS.map((kind) => (
        <Link
          aria-current={kind === current ? 'page' : undefined}
          className={cn(
            CHIP,
            kind === current ? CHOSEN : 'bg-secondary',
            counts.kind[kind] === 0 && kind !== current && 'opacity-40',
          )}
          key={kind}
          resetScroll={false}
          search={(previous) => ({ ...previous, kind })}
          to="."
        >
          {KIND_NAMES[kind]}{' '}
          <span className="ml-1.5 text-xs tabular-nums">{counts.kind[kind]}</span>
        </Link>
      ))}
    </nav>
  );
}

// The System filter: every System, with what it would show.
export function SystemSelect({
  counts,
  current,
  onChange,
  unpaired,
}: {
  counts: Record<string, number>;
  current: string | undefined;
  onChange: (system: string | undefined) => void;
  unpaired: ReadonlySet<string>;
}) {
  const systems = Object.keys(counts).toSorted((a, b) => a.localeCompare(b));
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="sr-only">System</span>
      <select
        className="min-h-11 max-w-full rounded-md border bg-secondary px-2 text-sm text-foreground"
        onChange={(event) => {
          onChange(event.target.value === '' ? undefined : event.target.value);
        }}
        value={current ?? ''}
      >
        <option value="">All Systems</option>
        {[...new Set([...systems, ...(current === undefined ? [] : [current])])].map((system) => (
          <option key={system} value={system}>
            {system}
            {unpaired.has(system) ? ' · Unpaired' : ''} ({counts[system] ?? 0})
          </option>
        ))}
      </select>
    </label>
  );
}

// The segmented control that picks how far back the page looks.
export function ActivityRangePicker({ current }: { current: ActivityRange }) {
  return (
    <nav aria-label="Range" className="inline-flex overflow-hidden rounded-md border text-[13px]">
      {ACTIVITY_RANGES.map((range) => (
        <Link
          aria-current={range === current ? 'page' : undefined}
          className={cn(
            'flex min-h-11 items-center px-[11px] py-1 text-muted-foreground',
            range === current && 'bg-secondary text-foreground',
          )}
          key={range}
          resetScroll={false}
          search={(previous) => ({ ...previous, range })}
          to="."
        >
          {RANGE_NAMES[range]}
        </Link>
      ))}
    </nav>
  );
}
