import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { filterServices, SERVICE_STATUS_FILTERS, serviceFilterCounts } from '../lib/services.ts';
import type { ServiceFilters, ServiceStatusFilter, ServiceSummary } from '../lib/services.ts';
import { cn } from '../lib/utils.ts';

const STATUS_NAMES: Record<ServiceStatusFilter, string> = {
  down: 'Down',
  restarted: 'Restarted',
  unknown: 'Unknown',
  up: 'Up',
  updates: 'Updates',
};
const emptyFilters = (): ServiceFilters => ({ status: [], system: [] });
const toggle = <T,>(values: T[], value: T): T[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

type FilterProps = { filters: ServiceFilters; onChange: (filters: ServiceFilters) => void };

export function ActiveServiceFilters({ filters, onChange }: FilterProps) {
  if (filters.status.length + filters.system.length === 0) {
    return null;
  }
  const pills = [
    ...filters.status.map((status) => ({
      key: `status:${status}`,
      label: STATUS_NAMES[status],
      remove: () => onChange({ ...filters, status: toggle(filters.status, status) }),
    })),
    ...filters.system.map((system) => ({
      key: `system:${system}`,
      label: system,
      remove: () => onChange({ ...filters, system: toggle(filters.system, system) }),
    })),
  ];
  return (
    <div
      aria-label="Active filters"
      className="flex flex-wrap items-center gap-2 pb-4"
      role="group"
    >
      {pills.map(({ key, label, remove }) => (
        <button
          aria-label={`Remove ${label} filter`}
          className="min-h-11 max-w-full rounded-full border bg-card px-3 text-sm wrap-anywhere"
          key={key}
          onClick={remove}
          type="button"
        >
          {label}{' '}
          <span aria-hidden="true" className="ml-1 text-muted-foreground">
            ×
          </span>
        </button>
      ))}
      <button
        className="min-h-11 px-2 text-sm text-primary underline underline-offset-4"
        onClick={() => onChange(emptyFilters())}
        type="button"
      >
        Clear
      </button>
    </div>
  );
}

function FilterChip({
  count,
  label,
  onClick,
  selected,
}: {
  count: number;
  label: string;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-label={`${label}, ${String(count)} Services`}
      aria-pressed={selected}
      className={cn(
        'min-h-11 max-w-full rounded-full border px-3 text-base wrap-anywhere',
        selected ? 'border-primary bg-primary/15 text-primary' : 'bg-card text-foreground',
        count === 0 && 'opacity-40',
      )}
      onClick={onClick}
      type="button"
    >
      {label} <span className="ml-1 text-sm tabular-nums">{count}</span>
    </button>
  );
}

// A native modal keeps focus inside the sheet and restores it to Filter on close.
export function ServiceFilterSheet({
  filters,
  onApply,
  onChange,
  onClose,
  open,
  rows,
}: FilterProps & {
  onApply: () => void;
  onClose: () => void;
  open: boolean;
  rows: readonly ServiceSummary[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open && element?.open === false) {
      element.showModal();
    } else if (!open) {
      element?.close();
    }
    return () => element?.close();
  }, [open]);
  const counts = serviceFilterCounts(rows, filters);
  const shown = filterServices(rows, filters).length;
  return (
    <dialog
      aria-labelledby="service-filter-title"
      className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border bg-background p-0 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-foreground backdrop:bg-black/60 sm:inset-0 sm:m-auto sm:max-w-lg sm:rounded-2xl"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          ) {
            onClose();
          }
        }
      }}
      ref={dialog}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-2">
        <h2 className="text-lg font-semibold" id="service-filter-title">
          Filter Services
        </h2>
        <button className="min-h-11 px-3 text-base text-primary" onClick={onClose} type="button">
          Close
        </button>
      </header>
      <div className="space-y-6 p-4">
        <fieldset>
          <legend className="mb-3 text-sm font-semibold text-muted-foreground">Status</legend>
          <div className="flex flex-wrap gap-2">
            {SERVICE_STATUS_FILTERS.map((status) => (
              <FilterChip
                count={counts.status[status]}
                key={status}
                label={STATUS_NAMES[status]}
                onClick={() => onChange({ ...filters, status: toggle(filters.status, status) })}
                selected={filters.status.includes(status)}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-3 text-sm font-semibold text-muted-foreground">System</legend>
          <div className="flex flex-wrap gap-2">
            {Object.keys(counts.system)
              .toSorted((a, b) => a.localeCompare(b))
              .map((system) => (
                <FilterChip
                  count={counts.system[system] ?? 0}
                  key={system}
                  label={system}
                  onClick={() => onChange({ ...filters, system: toggle(filters.system, system) })}
                  selected={filters.system.includes(system)}
                />
              ))}
          </div>
        </fieldset>
      </div>
      <footer className="sticky bottom-0 flex items-center justify-between gap-4 border-t bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          className="min-h-11 text-base text-primary"
          onClick={() => onChange(emptyFilters())}
          type="button"
        >
          Clear all
        </button>
        <button
          className="min-h-11 rounded-lg bg-primary px-5 text-base font-semibold text-primary-foreground"
          onClick={onApply}
          type="button"
        >
          Show {shown} Services
        </button>
      </footer>
    </dialog>
  );
}

export function ServicesFilters({
  filters,
  onChange,
  rows,
}: FilterProps & { rows: readonly ServiceSummary[] }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const count = filters.status.length + filters.system.length;
  return (
    <>
      <button
        aria-haspopup="dialog"
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border bg-card px-3 text-base"
        onClick={() => {
          setDraft(filters);
          setOpen(true);
        }}
        type="button"
      >
        <SlidersHorizontal aria-hidden="true" className="size-4" /> Filter
        {count > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 text-xs text-primary">{count}</span>
        )}
      </button>
      <ServiceFilterSheet
        filters={draft}
        onApply={() => {
          onChange(draft);
          setOpen(false);
        }}
        onChange={setDraft}
        onClose={() => setOpen(false)}
        open={open}
        rows={rows}
      />
    </>
  );
}
