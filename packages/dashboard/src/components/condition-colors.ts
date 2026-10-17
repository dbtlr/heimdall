import type { ConditionLevel } from '@heimdall/schema';

// A level's colour in a chart, the same as its glyph.
export const LEVEL_STROKE: Record<ConditionLevel, string> = {
  alert: 'var(--status-critical)',
  note: 'var(--status-warning)',
  warning: 'var(--status-serious)',
};
