import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '../lib/utils.ts';

export const toggle = <T,>(values: T[], value: T): T[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

export type FilterChipSpec = { count: number; label: string; selected: boolean; value: string };
export type FilterSection = { chips: FilterChipSpec[]; key: string; title: string };
export type FilterNoun = { one: string; other: string };
const nounFor = (noun: FilterNoun, count: number) => (count === 1 ? noun.one : noun.other);

export type FilterPill = { key: string; label: string; remove: () => void };

// Removable pills for the active filters, with Clear for all of them.
export function ActiveFilters({ onClear, pills }: { onClear: () => void; pills: FilterPill[] }) {
  if (pills.length === 0) {
    return null;
  }
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
        onClick={onClear}
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
  noun,
  onClick,
  selected,
}: {
  count: number;
  label: string;
  noun: FilterNoun;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-label={`${label}, ${String(count)} ${nounFor(noun, count)}`}
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
export function FilterSheet({
  noun,
  onApply,
  onClear,
  onClose,
  onToggle,
  open,
  sections,
  shown,
  title,
  titleId,
}: {
  noun: FilterNoun;
  onApply: () => void;
  onClear: () => void;
  onClose: () => void;
  onToggle: (section: string, value: string) => void;
  open: boolean;
  sections: FilterSection[];
  shown: number;
  title: string;
  titleId: string;
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
  return (
    <dialog
      aria-labelledby={titleId}
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
        <h2 className="text-lg font-semibold" id={titleId}>
          {title}
        </h2>
        <button className="min-h-11 px-3 text-base text-primary" onClick={onClose} type="button">
          Close
        </button>
      </header>
      <div className="space-y-6 p-4">
        {sections.map((section) => (
          <fieldset key={section.key}>
            <legend className="mb-3 text-sm font-semibold text-muted-foreground">
              {section.title}
            </legend>
            <div className="flex flex-wrap gap-2">
              {section.chips.map((chip) => (
                <FilterChip
                  count={chip.count}
                  key={chip.value}
                  label={chip.label}
                  noun={noun}
                  onClick={() => onToggle(section.key, chip.value)}
                  selected={chip.selected}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <footer className="sticky bottom-0 flex items-center justify-between gap-4 border-t bg-background px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button className="min-h-11 text-base text-primary" onClick={onClear} type="button">
          Clear all
        </button>
        <button
          className="min-h-11 rounded-lg bg-primary px-5 text-base font-semibold text-primary-foreground"
          onClick={onApply}
          type="button"
        >
          Show {shown} {nounFor(noun, shown)}
        </button>
      </footer>
    </dialog>
  );
}

// The Filter button and its sheet; edits stay a draft until Show applies them.
export function FilterControl<F>({
  activeCount,
  empty,
  filters,
  noun,
  onChange,
  sheetFor,
  title,
  titleId,
  toggleIn,
}: {
  activeCount: number;
  empty: () => F;
  filters: F;
  noun: FilterNoun;
  onChange: (filters: F) => void;
  sheetFor: (draft: F) => { sections: FilterSection[]; shown: number };
  title: string;
  titleId: string;
  toggleIn: (draft: F, section: string, value: string) => F;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
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
        {activeCount > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 text-xs text-primary">
            {activeCount}
          </span>
        )}
      </button>
      <FilterSheet
        {...sheetFor(draft)}
        noun={noun}
        onApply={() => {
          onChange(draft);
          setOpen(false);
        }}
        onClear={() => setDraft(empty())}
        onClose={() => setOpen(false)}
        onToggle={(section, value) => setDraft(toggleIn(draft, section, value))}
        open={open}
        title={title}
        titleId={titleId}
      />
    </>
  );
}
