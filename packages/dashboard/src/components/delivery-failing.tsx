import { cn } from '../lib/utils.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { DateTime } from './date-time.tsx';

// The Fleet page's strip under the header when the Hub cannot deliver alerts
// (ADR-0020). It is a status of the Hub, not a Condition, so it joins no count
// or list.
export function DeliveryFailing({ now, since }: { now: number; since: number }) {
  return (
    <p
      className={cn(
        'mt-3 flex items-center gap-2 rounded-lg bg-status-serious/10 px-2.5 py-1.5 text-sm',
        MARK_COLOR.warning,
      )}
    >
      <ConditionGlyph kind="warning" />
      <span>
        Alert delivery failing since <DateTime at={since} format="when" now={now} />
      </span>
    </p>
  );
}
