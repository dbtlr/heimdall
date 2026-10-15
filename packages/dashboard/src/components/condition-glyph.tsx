import type { ConditionLevel } from '@heimdall/schema';

import { cn } from '../lib/utils.ts';

// The mark for a Condition: a square for alert, a triangle for warning, a
// diamond for note, a green ring for one that cleared, and a hollow grey
// ring for evidence that does not confirm a failure.
export function ConditionGlyph({
  className,
  kind,
}: {
  className?: string;
  kind: ConditionLevel | 'cleared' | 'unknown';
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn(
        'size-[11px] flex-none',
        kind === 'alert' && 'fill-status-critical',
        kind === 'warning' && 'fill-status-serious',
        kind === 'note' && 'fill-status-warning',
        kind === 'cleared' && 'fill-none stroke-status-good stroke-2',
        kind === 'unknown' && 'fill-none stroke-muted-foreground stroke-[1.6]',
        className,
      )}
      viewBox="0 0 12 12"
    >
      {kind === 'alert' && <rect height="10" rx="1.5" width="10" x="1" y="1" />}
      {kind === 'warning' && <path d="M6 .8 11.4 11H.6z" />}
      {kind === 'note' && <path d="M6 .5 11.5 6 6 11.5.5 6z" />}
      {(kind === 'cleared' || kind === 'unknown') && <circle cx="6" cy="6" r="4.2" />}
    </svg>
  );
}
