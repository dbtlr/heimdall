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

// A level's shade over a span of a chart, such as the time a Condition was
// open: its colour as a light fill between two faint edges. Full class names,
// so Tailwind finds them.
export const LEVEL_SHADE: Record<ConditionLevel, string> = {
  alert: 'border-status-critical/50 bg-status-critical/20',
  note: 'border-status-warning/50 bg-status-warning/20',
  warning: 'border-status-serious/50 bg-status-serious/20',
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
