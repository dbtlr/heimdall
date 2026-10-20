import { cn } from '../lib/utils.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { DateTime } from './date-time.tsx';

// The Fleet page's line when the Hub cannot deliver alerts (ADR-0020). It is a
// status of the Hub, not a Condition, so it joins no count or list.
export function DeliveryFailing({ now, since }: { now: number; since: number }) {
  return (
    <p className={cn('mt-2 text-base', MARK_COLOR.warning)}>
      Alert delivery failing since <DateTime at={since} format="when" now={now} />
    </p>
  );
}
