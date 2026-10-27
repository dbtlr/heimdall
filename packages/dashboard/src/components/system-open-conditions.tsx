import { withoutServiceRestartedNotes } from '../lib/attention.ts';
import type { Attention } from '../server/attention-types.ts';
import { AttentionList } from './attention-list.tsx';

export function SystemOpenConditions({ items, now }: { items: readonly Attention[]; now: number }) {
  const attention = withoutServiceRestartedNotes(items);
  return (
    <>
      <h2 className="mb-2 text-lg font-semibold">Open Conditions</h2>
      {attention.length === 0 ? (
        <p className="rounded-xl bg-card p-4 text-base">No open Condition or uncertain evidence.</p>
      ) : (
        <AttentionList compact items={attention} layout="table" now={now} />
      )}
    </>
  );
}
