import { Link } from '@tanstack/react-router';

import { ConditionGlyph } from './condition-glyph.tsx';

// The "Can wait" shelf under the Fleet tiles: one muted row per System with
// notes, each linking to that System. Notes leave a System healthy, so they sit
// here rather than on its tile. Nothing without rows.
export function CanWait({
  rows,
}: {
  rows: readonly { notes: readonly string[]; system: string }[];
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="mt-3 text-sm text-muted-foreground">
      <h2 className="px-0.5 pb-1 text-xs tracking-[0.07em] uppercase">Can wait</h2>
      {rows.map(({ notes, system }) => (
        <Link
          className="flex flex-wrap items-baseline gap-x-2 border-t px-0.5 py-1.5 first-of-type:border-t-0"
          key={system}
          params={{ name: system }}
          to="/systems/$name"
        >
          <b className="font-semibold text-[#cfd5e3]">{system}</b>
          <span className="min-w-0 wrap-anywhere">
            <ConditionGlyph className="mr-1.5 inline size-2" kind="note" />
            {notes.join(' · ')}
          </span>
        </Link>
      ))}
    </section>
  );
}
