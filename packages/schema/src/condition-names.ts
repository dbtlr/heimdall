import { CLOCK_SKEW_SUBJECTS } from './conditions.ts';
import { parseProcessSubject } from './process-observation.ts';
import { parseUpdateSubject, UPDATE_MANAGER_NAMES } from './updates-section.ts';

// What a Condition is about. Its subject tells occurrences of one kind apart: a
// job Condition's is the job's name, a low disk Condition's the mount, a Drift
// Condition's the file's path, and a Service down Condition's the Service's
// name. A clock skew Condition's is empty for the System's own clock and `hub`
// for the Hub's. The rest are empty: stale System, high CPU and memory.
export type ConditionKind =
  | 'clock_skew'
  | 'drift'
  | 'high_cpu'
  | 'high_memory'
  | 'hot_process'
  | 'job_failing'
  | 'job_overdue'
  | 'low_disk'
  | 'pending_update'
  | 'reboot_required'
  | 'reports_rejected'
  | 'service_down'
  | 'system_stale';

// How the dashboard and the Hub's deliveries name each kind of Condition.
export const CONDITION_KIND_NAMES: Record<ConditionKind, string> = {
  clock_skew: 'Clock skew',
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
      : `${source.name} (${updateManagerName(source.manager)}, ${source.installation})`;
  }
  if (kind === 'clock_skew') {
    return subject === CLOCK_SKEW_SUBJECTS.hub ? "Hub's clock" : '';
  }
  if (kind !== 'hot_process') {
    return subject;
  }
  const process = parseProcessSubject(subject);
  return process === undefined ? 'Unknown process' : `${process.name} (PID ${String(process.pid)})`;
};
