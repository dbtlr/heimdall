import { Link } from '@tanstack/react-router';

import {
  ATTENTION_NAMES,
  anchorOf,
  evidenceNote,
  evidenceWords,
  nextSteps,
  subjectText,
} from '../lib/attention.ts';
import { fleetAttention } from '../lib/fleet.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { DateTime, PhraseText } from './date-time.tsx';

function ConditionCard({ item, now }: { item: Attention; now: number }) {
  const mark = item.level ?? 'unknown';
  const note = evidenceNote(item, now);
  return (
    <Link
      className="block min-w-0 rounded-xl border bg-card p-4 hover:border-muted-foreground"
      hash={anchorOf(item)}
      params={{ name: item.system }}
      to="/systems/$name"
    >
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className={cn('flex items-center gap-2 font-semibold capitalize', MARK_COLOR[mark])}>
          <ConditionGlyph kind={mark} />
          {item.level ?? 'Evidence unknown'}
        </span>
        <span className="min-w-0 break-all text-muted-foreground">
          {item.system}
          {item.unpaired ? ' · unpaired' : ''}
        </span>
      </div>
      <h3 className="mt-1 text-xl font-semibold wrap-anywhere">
        {ATTENTION_NAMES[item.kind]}
        {subjectText(item) === '' ? '' : `: ${subjectText(item)}`}
      </h3>
      <p className="mt-1 text-base wrap-anywhere">
        <PhraseText phrase={evidenceWords(item, now).observedShort} />
      </p>
      {item.evidence !== 'current' && (
        <p className="mt-2 text-sm text-muted-foreground">
          Evidence {item.evidence}
          {note === undefined ? '' : ': '}
          <PhraseText phrase={note ?? []} />
        </p>
      )}
      <p className="mt-2 text-sm text-muted-foreground">
        Latest check:{' '}
        {item.checkedAt === undefined ? (
          'none received'
        ) : (
          <DateTime at={item.checkedAt} format="when" now={now} />
        )}
      </p>
      <p className="mt-2 text-base text-primary">{nextSteps(item).short} →</p>
    </Link>
  );
}

export function FleetAttention({ items, now }: { items: readonly Attention[]; now: number }) {
  const { needsYou, notes, evidence } = fleetAttention(items);
  const cards = (group: readonly Attention[]) => (
    <div className="grid gap-3 sm:grid-cols-2">
      {group.map((item) => (
        <ConditionCard item={item} key={`${item.system}-${anchorOf(item)}`} now={now} />
      ))}
    </div>
  );
  return (
    <section aria-label="Fleet Conditions" className="mt-4">
      {needsYou.length > 0 && (
        <>
          <h2 className="mb-3 text-lg font-semibold">Needs you</h2>
          {cards(needsYou)}
        </>
      )}
      {notes.length > 0 && (
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-base text-primary underline underline-offset-4">
            {notes.length} note{notes.length === 1 ? '' : 's'} · show what can wait
          </summary>
          {cards(notes)}
        </details>
      )}
      {evidence.length > 0 && (
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-base text-muted-foreground underline underline-offset-4">
            Evidence old or unknown · {evidence.length} item{evidence.length === 1 ? '' : 's'}
          </summary>
          {cards(evidence)}
        </details>
      )}
    </section>
  );
}
