import { isMaintenanceNote, withoutNotesShownElsewhere } from '../lib/attention.ts';
import { itemName } from '../lib/home.ts';
import { formatSpanShort } from '../lib/time.ts';
import type { Attention } from '../server/attention-types.ts';
import { AttentionLink } from './attention-link.tsx';
import { AttentionList } from './attention-list.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';

export function SystemOpenConditions({ items, now }: { items: readonly Attention[]; now: number }) {
  const attention = withoutNotesShownElsewhere(items);
  return (
    <>
      <h2 className="mb-2 text-lg font-semibold">Open Conditions</h2>
      {attention.length === 0 ? (
        <p className="card-surface rounded-xl border p-4 text-base">
          No open Condition or uncertain evidence.
        </p>
      ) : (
        <AttentionList compact items={attention} layout="table" now={now} />
      )}
    </>
  );
}

// The System's maintenance notes, a Pending update or Reboot required at the
// note level, each linking to its Condition page with how long it has been
// open. They wait here rather than among the open Conditions. Nothing without one.
export function SystemMaintenance({ items, now }: { items: readonly Attention[]; now: number }) {
  const notes = items
    .filter((item) => isMaintenanceNote(item))
    .toSorted((a, b) => a.firstDetected - b.firstDetected);
  if (notes.length === 0) {
    return null;
  }
  return (
    <section className="mt-4">
      <h2 className="mb-2 text-lg font-semibold">Maintenance</h2>
      <ul className="card-surface rounded-xl border px-4 py-1.5 text-[13px]">
        {notes.map((item) => (
          <li className="border-t first:border-t-0" key={item.conditionId}>
            <AttentionLink
              className="flex min-h-9 min-w-0 items-center gap-2 hover:underline"
              item={item}
            >
              <ConditionGlyph kind="note" />
              <span className="min-w-0 flex-1 wrap-anywhere">{itemName(item)}</span>
              <span className="flex-none text-xs text-dim tabular-nums">
                open {formatSpanShort(Math.max(0, now - item.firstDetected))}
              </span>
            </AttentionLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
