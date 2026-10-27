import { Link, useLocation } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import {
  ATTENTION_NAMES,
  anchorOf,
  attentionMark,
  evidenceNote,
  evidenceWords,
  nextSteps,
  rankAttention,
} from '../lib/attention.ts';
import { whenAt } from '../lib/phrase.ts';
import type { Phrase } from '../lib/phrase.ts';
import { formatSpanShort } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import { AttentionSubject, MARK_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { DateTime, PhraseText } from './date-time.tsx';

// Seven columns from `lg`: Condition, Subject, Expected, Observed, First
// detected, Latest check, Next step.
const COLUMNS =
  'lg:grid-cols-[118px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_90px_90px_minmax(0,1.2fr)]';

const HEADINGS = [
  'Condition',
  'Subject',
  'Expected',
  'Observed',
  'First detected',
  'Latest check',
  'Next step',
];

// A compact row as one line on a wide screen: glyph, Condition, subject, what was
// observed, how long it has been open, the latest check, and the way to open it.
const TABLE_ROW =
  'lg:grid lg:min-h-0 lg:grid-cols-[16px_minmax(9rem,auto)_minmax(10rem,auto)_minmax(0,1fr)_auto_auto_auto] lg:items-baseline lg:gap-x-4 lg:py-2';

const COMMAND =
  'mt-1 block rounded bg-background px-2 py-1 font-mono text-[12.5px] break-all whitespace-pre-wrap';

// A label that names a value on a narrow screen, where the column headings are gone.
function Label({ children }: { children: string }) {
  return <span className="text-xs text-muted-foreground lg:hidden">{children} </span>;
}

// The phrase as a sentence: ends with a full stop unless it already does.
const sentence = (phrase: Phrase): Phrase => {
  const last = phrase.at(-1);
  return typeof last === 'string' && last.endsWith('.') ? phrase : [...phrase, '.'];
};

// An item's row, which opens to show it: the Condition, its subject, what was
// expected and observed, when it was first detected and last checked, and the
// first thing to do, in a seven-column row on a wide screen, stacked on a narrow one.
function Summary({
  compact,
  item,
  now,
  table,
}: {
  compact: boolean;
  item: Attention;
  now: number;
  table: boolean;
}) {
  const mark = attentionMark(item);
  const words = evidenceWords(item, now);
  if (compact) {
    const level =
      item.level === undefined
        ? 'Evidence old or unknown'
        : item.level.charAt(0).toUpperCase() + item.level.slice(1);
    return (
      <summary
        className={cn(
          'min-h-11 cursor-pointer list-none py-3 [&::-webkit-details-marker]:hidden',
          table && TABLE_ROW,
        )}
      >
        <span
          className={cn(
            'flex items-center gap-2 text-sm font-semibold',
            table && 'lg:contents',
            MARK_COLOR[mark],
          )}
        >
          <ConditionGlyph kind={mark} />
          <span className={table ? 'lg:sr-only' : undefined}>{level}</span>
          {table && (
            <span className="hidden font-semibold whitespace-nowrap lg:inline">
              {ATTENTION_NAMES[item.kind]}
            </span>
          )}
        </span>
        <span
          className={cn(
            'mt-1 block text-xl font-semibold wrap-anywhere [&_code]:text-base',
            table && 'lg:contents lg:text-[13px] lg:font-normal lg:[&_code]:text-[12.5px]',
          )}
        >
          {table ? (
            <span className="lg:hidden">{ATTENTION_NAMES[item.kind]}</span>
          ) : (
            ATTENTION_NAMES[item.kind]
          )}{' '}
          <AttentionSubject item={item} />
        </span>
        <span
          className={cn(
            'mt-1 block text-base text-muted-foreground',
            table && 'lg:mt-0 lg:min-w-0 lg:text-[13px] lg:wrap-anywhere',
          )}
        >
          <PhraseText phrase={words.observedShort} />
        </span>
        {table && (
          <>
            <span className="hidden text-xs whitespace-nowrap text-muted-foreground lg:block">
              open {formatSpanShort(Math.max(0, now - item.firstDetected))}
            </span>
            <span className="hidden text-xs whitespace-nowrap text-muted-foreground lg:block">
              {item.checkedAt === undefined ? (
                'no check'
              ) : (
                <>
                  checked <DateTime at={item.checkedAt} format="when" now={now} />
                </>
              )}
            </span>
          </>
        )}
        <span
          className={cn(
            'mt-1 block text-sm text-primary',
            table && 'lg:mt-0 lg:text-xs lg:whitespace-nowrap',
          )}
        >
          Evidence and next step
        </span>
      </summary>
    );
  }
  return (
    <summary
      className={cn(
        'relative grid cursor-pointer list-none grid-cols-2 gap-x-2.5 gap-y-0.5 py-2 pl-4 lg:gap-x-2.5 [&::-webkit-details-marker]:hidden',
        COLUMNS,
      )}
    >
      <span
        aria-hidden="true"
        className="absolute top-[13px] left-px size-[5px] -rotate-45 border-r-[1.5px] border-b-[1.5px] border-muted-foreground group-open:top-[11px] group-open:rotate-45"
      />
      <span
        className={cn(
          'inline-flex items-baseline gap-1 self-start font-semibold whitespace-nowrap',
          MARK_COLOR[mark],
        )}
        title={item.level === undefined ? 'Evidence old or unknown' : `Hub level: ${item.level}`}
      >
        <ConditionGlyph className="self-center" kind={mark} />
        {ATTENTION_NAMES[item.kind]}
      </span>
      <span className="col-span-full row-start-2 wrap-anywhere lg:col-auto lg:row-auto">
        <AttentionSubject item={item} />
      </span>
      <span className="col-span-full wrap-anywhere lg:col-auto">
        <Label>Expected</Label>
        <PhraseText phrase={words.expectedShort} />
      </span>
      <span
        className={cn('col-span-full wrap-anywhere lg:col-auto', mark === 'unknown' && 'italic')}
      >
        <Label>Observed</Label>
        <PhraseText phrase={words.observedShort} />
      </span>
      <span>
        <Label>First detected</Label>
        <DateTime at={item.firstDetected} format="when" now={now} />
      </span>
      <span>
        <Label>Latest check</Label>
        {item.checkedAt === undefined ? (
          '—'
        ) : (
          <DateTime at={item.checkedAt} format="when" now={now} />
        )}
      </span>
      <span className="col-span-full wrap-anywhere lg:col-auto">
        <Label>Next step</Label>
        {nextSteps(item).short}
      </span>
    </summary>
  );
}

const SUBHEADING =
  'mb-[3px] text-[11.5px] font-normal tracking-[0.06em] text-muted-foreground uppercase';

// What an item rests on: what was expected, what was observed, what to make of
// the evidence, and when the latest check arrived.
function Evidence({ item, now }: { item: Attention; now: number }) {
  const words = evidenceWords(item, now);
  const note = evidenceNote(item, now);
  return (
    <div>
      <h4 className={SUBHEADING}>Evidence</h4>
      <p className="mb-[3px]">
        <b className="font-semibold">Expected:</b> <PhraseText phrase={sentence(words.expected)} />
      </p>
      <p className="mb-[3px]">
        <b className="font-semibold">Observed:</b> <PhraseText phrase={words.observed} />
      </p>
      {words.context !== undefined && (
        <p className="mb-[3px] text-muted-foreground">{words.context}</p>
      )}
      {note !== undefined && (
        <p className="mb-[3px] text-muted-foreground">
          <PhraseText phrase={note} />
        </p>
      )}
      <p className="mb-[3px] text-xs text-muted-foreground">
        First detected <DateTime at={item.firstDetected} format="when" now={now} />
      </p>
      <p className="mb-[3px] text-xs text-muted-foreground">
        {item.checkedAt === undefined ? (
          'No check has arrived.'
        ) : (
          <PhraseText phrase={['Latest check ', whenAt(item.checkedAt, now), '.']} />
        )}
      </p>
      {item.conditionId !== undefined && (
        <Link
          className="mt-1 inline-flex min-h-11 items-center text-base text-primary"
          params={{ id: item.conditionId, name: item.system }}
          to="/systems/$name/conditions/$id"
        >
          Open
        </Link>
      )}
    </div>
  );
}

// What the operator can do about an item: each step's title and words, and the
// commands to run, in a numbered list when there is more than one step.
function NextStep({ item }: { item: Attention }) {
  const { steps } = nextSteps(item);
  const body = steps.map((step) => (
    <li key={step.title}>
      <b className="font-semibold">{step.title}.</b> {step.text}
      {step.commands.map((command) => (
        <code className={COMMAND} key={command}>
          {command}
        </code>
      ))}
    </li>
  ));
  return (
    <div>
      <h4 className={SUBHEADING}>Next step</h4>
      {steps.length > 1 ? (
        <ol className="list-decimal space-y-1.5 pl-5">{body}</ol>
      ) : (
        <ul className="list-none">{body}</ul>
      )}
    </div>
  );
}

// One item: a row that opens to its evidence and next step. Unconfirmed
// evidence is muted, its observed words in italics, with a dashed rule above.
function AttentionItem({
  compact,
  item,
  now,
  onToggle,
  open,
  table,
}: {
  compact: boolean;
  item: Attention;
  now: number;
  onToggle: (open: boolean) => void;
  open: boolean;
  table: boolean;
}) {
  return (
    <details
      className={cn(
        'group scroll-mt-44 border-t first-of-type:border-t-0',
        attentionMark(item) === 'unknown' && 'border-dashed text-[#b3bacb]',
      )}
      id={anchorOf(item)}
      onToggle={(event) => {
        onToggle(event.currentTarget.open);
      }}
      open={open}
    >
      <Summary compact={compact} item={item} now={now} table={table} />
      <div className="grid gap-2.5 pt-0.5 pb-3 pl-4 lg:grid-cols-2 lg:gap-[22px]">
        <Evidence item={item} now={now} />
        <NextStep item={item} />
      </div>
    </details>
  );
}

// The open items an anchor in the location names, as an anchor without its '#'.
const hashAnchor = (hash: string) => hash.replace(/^#/u, '');

// Everything that needs the operator on this System, confirmed failures first,
// then unconfirmed evidence. The first item starts open; the item the location's
// hash names opens and scrolls into view, on arrival and whenever the hash
// changes, but not when a refresh changes the items. Nothing when the System
// has none.
export function AttentionList({
  compact = false,
  items,
  layout = 'list',
  now,
}: {
  compact?: boolean;
  items: readonly Attention[];
  // 'table' makes each compact row one line from `lg`; it changes nothing below it.
  layout?: 'list' | 'table';
  now: number;
}) {
  const ranked = (({ confirmed, unconfirmed }) => [...confirmed, ...unconfirmed])(
    rankAttention(items),
  );
  const first = ranked[0];
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(first === undefined || compact ? [] : [anchorOf(first)]),
  );
  const hash = hashAnchor(useLocation({ select: (location) => location.hash }));
  useEffect(() => {
    if (hash === '' || document.getElementById(hash) === null) {
      return;
    }
    setOpened((previous) => new Set(previous).add(hash));
    document.getElementById(hash)?.scrollIntoView({ block: 'start' });
  }, [hash]);
  if (first === undefined) {
    return null;
  }
  return (
    <section
      aria-label="Needs you"
      className={cn(
        'mt-1 mb-2.5 rounded-lg bg-card px-3 py-1 text-[13px]',
        compact && 'max-h-[65dvh] overflow-y-auto overscroll-contain',
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'hidden gap-x-2.5 border-b py-1.5 pl-4 text-xs text-muted-foreground',
          !compact && 'lg:grid',
          COLUMNS,
        )}
      >
        {HEADINGS.map((heading) => (
          <span key={heading}>{heading}</span>
        ))}
      </div>
      {ranked.map((item) => {
        const id = anchorOf(item);
        return (
          <AttentionItem
            compact={compact}
            item={item}
            key={id}
            now={now}
            onToggle={(open) => {
              setOpened((previous) => {
                const next = new Set(previous);
                if (open) {
                  next.add(id);
                } else {
                  next.delete(id);
                }
                return next;
              });
            }}
            open={opened.has(id)}
            table={compact && layout === 'table'}
          />
        );
      })}
    </section>
  );
}
