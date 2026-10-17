import { parseProcessSubject, parseUpdateSubject, UPDATE_MANAGER_NAMES } from '@heimdall/schema';
import type { ConditionLevel, ConditionTransition } from '@heimdall/schema';

import type { ConditionKind } from '../server/fleet-overview-types.ts';

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

export const KIND_NAMES: Record<ConditionKind, string> = {
  drift: 'Drift',
  high_cpu: 'High CPU',
  high_memory: 'High memory',
  hot_process: 'Hot process',
  job_failing: 'Job failing',
  job_overdue: 'Job overdue',
  low_disk: 'Low disk',
  pending_update: 'Pending update',
  reboot_required: 'Reboot required',
  reports_rejected: 'Reports rejected',
  service_down: 'Service down',
  system_stale: 'Stale System',
};

// A package manager's display name; an unrecognized one reads as stored.
export const updateManagerName = (manager: string): string => {
  const names: Record<string, string> = UPDATE_MANAGER_NAMES;
  return names[manager] ?? manager;
};

// A process's stored subject carries its lifetime identity; only its name and
// PID belong in the labels shown to the operator.
export const conditionSubject = ({ kind, subject }: { kind: ConditionKind; subject: string }) => {
  if (kind === 'pending_update') {
    const source = parseUpdateSubject(subject);
    if (source === undefined) {
      return 'Unknown package';
    }
    // An occurrence from before packages were grouped names its one package.
    return source.name === undefined
      ? `${updateManagerName(source.manager)} (${source.installation})`
      : `${source.name} (${source.manager}, ${source.installation})`;
  }
  if (kind !== 'hot_process') {
    return subject;
  }
  const process = parseProcessSubject(subject);
  return process === undefined ? 'Unknown process' : `${process.name} (PID ${String(process.pid)})`;
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
