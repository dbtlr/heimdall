import {
  ATTENTION_NAMES,
  attentionMark,
  laneSummary,
  rankAttention,
  subjectText,
} from '../lib/attention.ts';
import type { Severity } from '../lib/conditions.ts';
import { statusWord } from '../lib/lane.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import type { LaneStatus } from '../server/fleet-overview-types.ts';

// The text colour of each status word.
const STATUS_COLOR: Record<LaneStatus, string> = {
  asleep: 'text-muted-foreground',
  needs_you: 'text-[color-mix(in_srgb,var(--status-serious)_70%,white)]',
  never_seen: 'text-muted-foreground',
  unpaired:
    'rounded-[10px] border border-dashed border-muted-foreground px-[7px] text-muted-foreground',
  up: 'text-[color-mix(in_srgb,var(--status-good)_60%,white)]',
};

// The text colour of each mark, a severity's status colour lightened toward
// white, or muted for unconfirmed evidence.
export const MARK_COLOR: Record<Severity | 'unknown', string> = {
  critical: 'text-[color-mix(in_srgb,var(--status-critical)_65%,white)]',
  serious: 'text-[color-mix(in_srgb,var(--status-serious)_70%,white)]',
  unknown: 'text-muted-foreground',
  warning: 'text-[color-mix(in_srgb,var(--status-warning)_75%,white)]',
};

// The item a System's status names: its most pressing confirmed one, else the
// first unconfirmed one when the System needs you only on unconfirmed evidence.
// An unpaired System names none; its status stays Unpaired.
export const namedItem = (
  items: readonly Attention[],
  status: LaneStatus,
): Attention | undefined => {
  if (status === 'unpaired') {
    return undefined;
  }
  const { confirmed, unconfirmed } = rankAttention(items);
  return confirmed[0] ?? (status === 'needs_you' ? unconfirmed[0] : undefined);
};

const PILL = 'ml-1.5 rounded-lg px-[5px] text-xs';

// How many pieces of evidence do not confirm a failure; hollow and dashed, so
// it never reads as one.
function UnconfirmedPill({ count, plus }: { count: number; plus: boolean }) {
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

// The status of a System: the name of its most pressing cause in that cause's
// severity colour, with how many other causes there are and how many pieces of
// unconfirmed evidence; else its plain status word.
export function AttentionStatus({
  className,
  items,
  status,
}: {
  className?: string;
  items: readonly Attention[];
  status: LaneStatus;
}) {
  const named = namedItem(items, status);
  const { more, unconfirmed } = laneSummary(items);
  // The named item, when unconfirmed, is already counted by its name.
  const others =
    named !== undefined && attentionMark(named) === 'unknown' ? unconfirmed - 1 : unconfirmed;
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
      {more > 0 && (
        <span className={cn(PILL, 'bg-status-serious/15', MARK_COLOR.serious)}>+{more}</span>
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
