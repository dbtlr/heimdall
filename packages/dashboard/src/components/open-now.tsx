import { Link } from '@tanstack/react-router';

import {
  ATTENTION_NAMES,
  anchorOf,
  attentionMark,
  evidenceWords,
  rankAttention,
} from '../lib/attention.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import { AttentionSubject, MARK_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { DateTime, PhraseText } from './date-time.tsx';

// Below `sm` a table row is a two-column grid; from `sm` it is a table row.
const ROW =
  'border-b border-border/60 hover:bg-accent max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-2.5 max-sm:py-[7px]';

const CELL = 'py-1.5 pr-2 align-baseline max-sm:p-0';

// A label that names a cell on a phone, where the column headings are gone.
function PhoneLabel({ children }: { children: string }) {
  return <span className="text-xs text-muted-foreground sm:hidden">{children} </span>;
}

// One open item as a table row: its System, its Condition linked to the
// System's page at that item, and the evidence in short.
function OpenRow({ item, now }: { item: Attention; now: number }) {
  const unconfirmed = attentionMark(item) === 'unknown';
  return (
    <tr className={cn(ROW, unconfirmed && 'border-dashed text-[#b3bacb]')}>
      <td className={cn(CELL, 'max-sm:font-semibold')}>
        {item.system}
        {item.unpaired && (
          <em className="ml-1 rounded border px-[5px] text-xs font-normal text-muted-foreground not-italic">
            unpaired
          </em>
        )}
      </td>
      <td className={cn(CELL, 'max-sm:text-right')}>
        <Link
          className={cn(
            'inline-flex items-baseline gap-1 whitespace-nowrap',
            unconfirmed ? 'font-medium' : 'font-semibold',
            MARK_COLOR[attentionMark(item)],
          )}
          hash={anchorOf(item)}
          params={{ name: item.system }}
          to="/systems/$name"
        >
          <ConditionGlyph className="self-center" kind={attentionMark(item)} />
          {ATTENTION_NAMES[item.kind]}
        </Link>
      </td>
      <td className={cn(CELL, 'wrap-anywhere max-sm:col-span-full')}>
        <AttentionSubject item={item} />
      </td>
      <td className={cn(CELL, 'max-sm:col-span-full', unconfirmed && 'italic')}>
        <PhraseText phrase={evidenceWords(item, now).observedShort} />
      </td>
      <td className={CELL}>
        <PhoneLabel>First detected</PhoneLabel>
        <DateTime at={item.firstDetected} format="when" now={now} />
      </td>
      <td className={CELL}>
        <PhoneLabel>Latest check</PhoneLabel>
        {item.checkedAt === undefined ? (
          '—'
        ) : (
          <DateTime at={item.checkedAt} format="when" now={now} />
        )}
      </td>
      <td
        aria-hidden="true"
        className={cn(CELL, 'pr-0 text-right text-muted-foreground max-sm:hidden')}
      >
        →
      </td>
    </tr>
  );
}

// Everything that needs the operator now across the Systems shown: the
// confirmed failures first, then the unconfirmed evidence under its own
// heading, each row linking to the System's page at that item.
export function OpenNow({ items, now }: { items: readonly Attention[]; now: number }) {
  const { confirmed, unconfirmed } = rankAttention(items);
  return (
    <section className="mt-[18px] rounded-lg bg-card p-4">
      <h2 className="mb-2 text-[12.5px] font-normal text-muted-foreground">
        {items.length === 0
          ? 'Open now'
          : `Needs you · ${String(confirmed.length)} open${unconfirmed.length > 0 ? `, ${String(unconfirmed.length)} unconfirmed` : ''}`}
      </h2>
      {items.length === 0 && <p>Nothing is open.</p>}
      {items.length > 0 && (
        <table className="w-full border-collapse text-[13px] max-sm:block">
          <thead className="max-sm:hidden">
            <tr className="border-b text-left text-xs text-muted-foreground">
              {['System', 'Condition', 'Subject', 'Observed', 'First detected', 'Latest check'].map(
                (title) => (
                  <th className="pr-2 pb-1 font-normal" key={title}>
                    {title}
                  </th>
                ),
              )}
              <th>
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {confirmed.map((item) => (
              <OpenRow item={item} key={anchorOf(item) + item.system} now={now} />
            ))}
          </tbody>
          {unconfirmed.length > 0 && (
            <tbody className="max-sm:block">
              <tr className="max-sm:block">
                <th
                  className="border-b border-dashed pt-3 pb-1 text-left text-xs font-normal text-muted-foreground italic max-sm:block max-sm:border-0 max-sm:pt-2"
                  colSpan={7}
                >
                  Unconfirmed evidence, not failures
                </th>
              </tr>
              {unconfirmed.map((item) => (
                <OpenRow item={item} key={anchorOf(item) + item.system} now={now} />
              ))}
            </tbody>
          )}
        </table>
      )}
    </section>
  );
}
