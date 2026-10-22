import type { ConditionLevel } from '@heimdall/schema';

import {
  ATTENTION_NAMES,
  attentionMark,
  laneSummary,
  isConfirmed,
  subjectText,
} from '../lib/attention.ts';
import { statusWord } from '../lib/lane.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import type { LaneStatus } from '../server/fleet-overview-types.ts';

// The text colour of each status word.
export const STATUS_COLOR: Record<LaneStatus, string> = {
  asleep: 'text-muted-foreground',
  needs_you: 'text-[color-mix(in_srgb,var(--status-serious)_70%,white)]',
  never_seen: 'text-muted-foreground',
  unpaired:
    'rounded-[10px] border border-dashed border-muted-foreground px-[7px] text-muted-foreground',
  up: 'text-[color-mix(in_srgb,var(--status-good)_60%,white)]',
};

// Stored Hub levels keep their color regardless of evidence freshness.
// Evidence without a Hub Condition uses the muted color.
export const MARK_COLOR: Record<ConditionLevel | 'unknown', string> = {
  alert: 'text-[color-mix(in_srgb,var(--status-critical)_65%,white)]',
  note: 'text-[color-mix(in_srgb,var(--status-warning)_75%,white)]',
  unknown: 'text-muted-foreground',
  warning: 'text-[color-mix(in_srgb,var(--status-serious)_70%,white)]',
};

// The worst open warning or alert names the System's status, even with old
// evidence. An unpaired System keeps its Unpaired status.
export const namedItem = (
  items: readonly Attention[],
  status: LaneStatus,
): Attention | undefined => {
  if (status === 'unpaired') {
    return undefined;
  }
  return laneSummary(items).lead;
};

const PILL = 'ml-1.5 rounded-lg px-[5px] text-xs';

// How many pieces of evidence do not confirm a failure; hollow and dashed, so
// it never reads as one.
export function UnconfirmedPill({ count, plus }: { count: number; plus: boolean }) {
  return (
    <span
      className={cn(PILL, 'border border-dashed border-muted-foreground text-muted-foreground')}
      title="unconfirmed evidence"
    >
      {plus ? '+' : ''}
      {count}?
    </span>
  );
}

// A System's worst open level calls for action independently of freshness.
// Notes alone leave its plain healthy status visible. `showSubject`
// adds what the worst one is about after its name.
export function AttentionStatus({
  className,
  items,
  showSubject = false,
  status,
}: {
  className?: string;
  items: readonly Attention[];
  showSubject?: boolean;
  status: LaneStatus;
}) {
  const named = namedItem(items, status);
  const { more, unconfirmed } = laneSummary(items);
  // The named item, when unconfirmed, is already counted by its name.
  const others = named !== undefined && !isConfirmed(named) ? unconfirmed - 1 : unconfirmed;
  const pill = others > 0 && status !== 'unpaired' && (
    <UnconfirmedPill count={others} plus={named !== undefined} />
  );
  if (named === undefined) {
    return (
      <span className={cn(STATUS_COLOR[status], className)}>
        {statusWord(status)}
        {pill}
      </span>
    );
  }
  const subject = subjectText(named);
  return (
    <span
      aria-label={`Needs you: ${ATTENTION_NAMES[named.kind]}${subject === '' ? '' : `, ${subject}`}`}
      className={className}
      role="group"
    >
      <b className={cn('font-semibold', MARK_COLOR[attentionMark(named)])}>
        {ATTENTION_NAMES[named.kind]}
      </b>
      {showSubject && subject !== '' && (
        <span className={MARK_COLOR[attentionMark(named)]}>
          {' '}
          <AttentionSubject item={named} />
        </span>
      )}
      {more > 0 && (
        <span className={cn(PILL, 'bg-status-serious/15', MARK_COLOR.warning)}>+{more}</span>
      )}
      {pill}
    </span>
  );
}

// What an item is about: a path, Service, job, or mount in monospace; the
// words for a missing set as text.
export function AttentionSubject({ item }: { item: Attention }) {
  const subject = subjectText(item);
  return item.kind === 'checks_missing' ? (
    subject
  ) : (
    <code className="font-mono text-[12.5px]">{subject}</code>
  );
}
