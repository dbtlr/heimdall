import type { ConditionLevel, ConditionTransition } from '@heimdall/schema';

export const LEVEL_FILL: Record<ConditionLevel, string> = {
  alert: 'bg-status-critical',
  note: 'bg-status-warning',
  warning: 'bg-status-serious',
};

// A level's colour in a chart, the same as its glyph.
export const LEVEL_STROKE: Record<ConditionLevel, string> = {
  alert: 'var(--status-critical)',
  note: 'var(--status-warning)',
  warning: 'var(--status-serious)',
};

export const transitionLabel = (transition: ConditionTransition): string => {
  switch (transition.kind) {
    case 'raised': {
      return `Raised at ${transition.level}`;
    }
    case 'level_changed': {
      return `${transition.previousLevel} → ${transition.level}`;
    }
    case 'cleared': {
      return `Cleared at ${transition.level}`;
    }
    default: {
      const _exhaustive: never = transition;
      return _exhaustive;
    }
  }
};
