import type { ConditionLevel } from '@heimdall/schema';

import { levelCountsText } from '../lib/fleet.ts';
import { cn } from '../lib/utils.ts';
import { MARK_COLOR, STATUS_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';

const LEVELS = ['alert', 'warning', 'note'] satisfies ConditionLevel[];

// The fleet verdict at the right end of the header: "All clear" when no paired
// item is at alert or warning level, else each open level's glyph and count.
export function FleetVerdict({ counts }: { counts: Record<ConditionLevel, number> }) {
  if (counts.alert + counts.warning === 0) {
    return (
      <span
        className={cn('flex items-center gap-1.5 text-[15.5px] font-semibold', STATUS_COLOR.up)}
      >
        <ConditionGlyph kind="cleared" />
        All clear
      </span>
    );
  }
  return (
    <span
      aria-label={levelCountsText(counts)}
      className="flex items-center gap-1.5 text-[15.5px] font-semibold"
      role="img"
    >
      {LEVELS.filter((level) => counts[level] > 0).map((level) => (
        <span className="flex items-center gap-1" key={level}>
          <ConditionGlyph kind={level} />
          <span className={MARK_COLOR[level]}>{String(counts[level])}</span>
        </span>
      ))}
    </span>
  );
}
