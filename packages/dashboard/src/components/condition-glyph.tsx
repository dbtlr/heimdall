import type { Severity } from '../lib/conditions.ts';
import { cn } from '../lib/utils.ts';

// The mark for a Condition: a square for critical, a triangle for serious, a
// diamond for warning, and a green ring for one that cleared.
export function ConditionGlyph({
  className,
  kind,
}: {
  className?: string;
  kind: Severity | 'cleared';
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn(
        'size-[11px] flex-none',
        kind === 'critical' && 'fill-status-critical',
        kind === 'serious' && 'fill-status-serious',
        kind === 'warning' && 'fill-status-warning',
        kind === 'cleared' && 'fill-none stroke-status-good stroke-2',
        className,
      )}
      viewBox="0 0 12 12"
    >
      {kind === 'critical' && <rect height="10" rx="1.5" width="10" x="1" y="1" />}
      {kind === 'serious' && <path d="M6 .8 11.4 11H.6z" />}
      {kind === 'warning' && <path d="M6 .5 11.5 6 6 11.5.5 6z" />}
      {kind === 'cleared' && <circle cx="6" cy="6" r="4.2" />}
    </svg>
  );
}
