import { conditionSubject, CONDITION_KIND_NAMES } from '@heimdall/schema';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { evidenceNote, evidenceWords, nextSteps } from '../lib/attention.ts';
import { conditionDetailView } from '../lib/condition-detail.ts';
import { LEVEL_STROKE } from '../lib/conditions.ts';
import { fleetAttention } from '../lib/fleet.ts';
import { itemTitle, pickAttention } from '../lib/home.ts';
import type { Actionable } from '../lib/home.ts';
import { serviceChecks } from '../lib/recorded.ts';
import { formatSpan, formatSpanShort } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import type { ClearedCondition, LeadEvidence } from '../server/home-types.ts';
import { AttentionLink } from './attention-link.tsx';
import { MARK_COLOR } from './attention-status.tsx';
import { ChartSection } from './condition-detail.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { PhraseText } from './date-time.tsx';
import { MemoryHolders } from './memory-holders.tsx';
import { RECORD_DOT } from './recorded-panel.tsx';

// The card's tint, warm for a warning and red for an alert, as a wash from its
// top-left corner over the card's own surface.
const TINT: Record<'alert' | 'warning', { border: string; wash: string }> = {
  alert: {
    border: 'border-status-critical/45',
    wash: 'bg-[linear-gradient(160deg,color-mix(in_srgb,var(--status-critical)_15%,transparent),transparent_60%)]',
  },
  warning: {
    border: 'border-status-serious/40',
    wash: 'bg-[linear-gradient(160deg,color-mix(in_srgb,var(--status-serious)_13%,transparent),transparent_60%)]',
  },
};

const CHIP: Record<'alert' | 'warning', string> = {
  alert: 'bg-status-critical/15',
  warning: 'bg-status-serious/15',
};

const COMMAND =
  'mt-1 block rounded bg-background px-2 py-1 font-mono text-[12.5px] break-all whitespace-pre-wrap';

const ROW = 'flex min-w-0 items-baseline justify-between gap-3 border-t py-1.5 first:border-t-0';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// A label and its value on one line, the value at the right.
function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <li className={ROW}>
      <span>{label}</span>
      <span className="min-w-0 text-right wrap-anywhere">{children}</span>
    </li>
  );
}

// What the operator can do first, with its commands, as the attention list
// words it.
function FirstStep({ item }: { item: Attention }) {
  const [step] = nextSteps(item).steps;
  if (step === undefined) {
    return null;
  }
  return (
    <div className="mt-3 text-[13px]">
      <p className="wrap-anywhere">
        <b className="font-semibold">Next step.</b> {step.text}
      </p>
      {step.commands.map((command) => (
        <code className={COMMAND} key={command}>
          {command}
        </code>
      ))}
    </div>
  );
}

// What was observed, with why the evidence is weaker when it is.
function Observed({ item, now }: { item: Attention; now: number }) {
  const words = evidenceWords(item, now);
  const note = evidenceNote(item, now);
  return (
    <div className="mt-2.5 text-[13px]">
      <p className="wrap-anywhere">
        <b className="font-semibold">Observed:</b> <PhraseText phrase={words.observed} />
      </p>
      {words.context !== undefined && <p className="text-muted-foreground">{words.context}</p>}
      {note !== undefined && (
        <p className="mt-0.5 text-muted-foreground">
          <PhraseText phrase={note} />
        </p>
      )}
    </div>
  );
}

// A down Service's latest checks, supervisor first, and its stops this week.
function ServiceDownEvidence({
  item,
  now,
  stops,
}: {
  item: Extract<Attention, { kind: 'service_down' }>;
  now: number;
  stops: number | undefined;
}) {
  const checks = serviceChecks({ checks: item.checks, name: item.subject, supervisor: '' }, now);
  if (checks.length === 0 && (stops ?? 0) === 0) {
    return <Observed item={item} now={now} />;
  }
  return (
    <ul className="mt-2.5 text-[13px]">
      {checks.map((check, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- checks keep the Hub's order and have no id.
        <Fact key={index} label={check.label}>
          <span
            className={cn('mr-1.5 inline-block size-2 rounded-full', RECORD_DOT[check.state])}
          />
          <PhraseText phrase={check.text} />
        </Fact>
      ))}
      {stops !== undefined && stops > 0 && (
        <Fact label="Stops this week">
          <span className="tabular-nums">{stops}</span>
        </Fact>
      )}
    </ul>
  );
}

// The chart of a High CPU or High memory Condition against its limit, and for
// High memory the processes holding the most, when the Hub holds them. Falls
// back to what was observed when there is nothing to chart.
function LoadEvidence({
  evidence,
  item,
  now,
}: {
  evidence: LeadEvidence | undefined;
  item: Actionable;
  now: number;
}) {
  const view =
    evidence?.detail === undefined ? undefined : conditionDetailView(evidence.detail, now);
  if (view?.chart === undefined) {
    return <Observed item={item} now={now} />;
  }
  return (
    <>
      <ChartSection
        chart={view.chart}
        className="mt-3"
        color={LEVEL_STROKE[item.level]}
        height={72}
      />
      {view.memoryHolders !== undefined && (
        <div className="mt-3">
          <MemoryHolders holders={view.memoryHolders} />
        </div>
      )}
    </>
  );
}

// The item that needs the operator most: what it is, its level and how long
// it has been open, linking to its page, then its evidence and first step.
function Lead({
  evidence,
  item,
  now,
}: {
  evidence: LeadEvidence | undefined;
  item: Actionable;
  now: number;
}) {
  const { level } = item;
  const open = `open ${formatSpan(Math.max(0, now - item.firstDetected))}`;
  let body: ReactNode = <Observed item={item} now={now} />;
  if (item.kind === 'high_cpu' || item.kind === 'high_memory') {
    body = <LoadEvidence evidence={evidence} item={item} now={now} />;
  } else if (item.kind === 'service_down') {
    body = <ServiceDownEvidence item={item} now={now} stops={evidence?.stops} />;
  }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <AttentionLink
          className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold wrap-anywhere hover:underline"
          item={item}
        >
          <ConditionGlyph kind={level} />
          {itemTitle(item)}
        </AttentionLink>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
            MARK_COLOR[level],
            CHIP[level],
          )}
        >
          {capitalize(level)} · {open}
        </span>
      </div>
      {body}
      <FirstStep item={item} />
    </div>
  );
}

// Every other item, one line each with its mark, linking to its page: the
// alerts and warnings after the lead, then the notes.
function OtherItems({ items, now }: { items: readonly Attention[]; now: number }) {
  return (
    <ul className="mt-3 border-t pt-1 text-[13px]">
      {items.map((item) => (
        <li key={`${item.system}-${item.kind}-${item.subject}`}>
          <AttentionLink
            className="flex min-h-9 min-w-0 items-center gap-2 hover:underline"
            item={item}
          >
            <ConditionGlyph kind={item.level ?? 'unknown'} />
            <span className="min-w-0 flex-1 truncate">{itemTitle(item)}</span>
            <span className="flex-none text-xs text-dim">
              open {formatSpanShort(Math.max(0, now - item.firstDetected))}
            </span>
          </AttentionLink>
        </li>
      ))}
    </ul>
  );
}

// Nothing needs the operator: says so, that only notes are open when some
// are, and names the Condition that cleared last, when one ever did.
function NothingOpen({
  cleared,
  notes,
  now,
}: {
  cleared: ClearedCondition | undefined;
  notes: boolean;
  now: number;
}) {
  const subject = cleared === undefined ? '' : conditionSubject(cleared);
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[15px] font-semibold">
        <ConditionGlyph kind="cleared" />
        {notes ? 'No alert or warning open' : 'Nothing open'}
      </p>
      {cleared !== undefined && (
        <p className="mt-1 text-[13px] text-muted-foreground">
          The last Condition cleared {formatSpan(Math.max(0, now - cleared.clearedAt))} ago:{' '}
          <Link
            className="text-foreground hover:underline"
            params={{ id: cleared.id, name: cleared.system }}
            to="/systems/$name/conditions/$id"
          >
            {CONDITION_KIND_NAMES[cleared.kind]}
            {subject === '' ? '' : ` ${subject}`} on {cleared.system}
          </Link>
          , open {formatSpan(Math.max(0, cleared.clearedAt - cleared.raisedAt))}.
        </p>
      )}
    </div>
  );
}

// Home's attention card: the worst open item, then the newest, with its
// evidence, tinted for its level; every other alert and warning after it in a
// line each; or, with none open, the Condition that cleared last. The notes on
// paired Systems follow as the last lines. They never tint the card (ADR-0017),
// and maintenance notes and Service restarted notes wait elsewhere.
export function NeedsAttention({
  attention,
  lastCleared,
  lead: evidence,
  now,
}: {
  attention: readonly Attention[];
  lastCleared: ClearedCondition | undefined;
  lead: LeadEvidence | undefined;
  now: number;
}) {
  const { lead, rest } = pickAttention(attention);
  const { notes } = fleetAttention(attention);
  const others = [...rest, ...notes];
  const level = lead?.level;
  return (
    <section
      aria-labelledby="needs-attention"
      className={cn(
        'relative min-w-0 overflow-hidden card-surface rounded-xl border px-4 py-3.5',
        level !== undefined && TINT[level].border,
      )}
      data-level={level}
    >
      {level !== undefined && (
        <div
          aria-hidden="true"
          className={cn('pointer-events-none absolute inset-0', TINT[level].wash)}
        />
      )}
      <div className="relative">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2
            className="text-[11px] font-semibold tracking-[0.08em] text-dim uppercase"
            id="needs-attention"
          >
            Needs attention
          </h2>
          <Link
            className="text-xs text-link hover:underline"
            search={{ status: ['open'] }}
            to="/timeline"
          >
            All Conditions →
          </Link>
        </div>
        {lead === undefined ? (
          <NothingOpen cleared={lastCleared} notes={notes.length > 0} now={now} />
        ) : (
          <Lead
            evidence={evidence?.conditionId === lead.conditionId ? evidence : undefined}
            item={lead}
            now={now}
          />
        )}
        {others.length > 0 && <OtherItems items={others} now={now} />}
      </div>
    </section>
  );
}
