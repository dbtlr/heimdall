import type { ConditionKind } from '../server/fleet-overview-types.ts';

export type Severity = 'critical' | 'serious' | 'warning';

// How much a Condition matters on the overview. The Hub does not rank
// Conditions; this is the dashboard's own reading.
export const SEVERITY: Record<ConditionKind, Severity> = {
  drift: 'warning',
  job_failing: 'serious',
  job_overdue: 'warning',
  low_disk: 'critical',
  reports_rejected: 'serious',
  service_down: 'critical',
  system_stale: 'critical',
};

export const KIND_NAMES: Record<ConditionKind, string> = {
  drift: 'Drift',
  job_failing: 'Job failing',
  job_overdue: 'Job overdue',
  low_disk: 'Low disk',
  reports_rejected: 'Reports rejected',
  service_down: 'Service down',
  system_stale: 'Stale System',
};
