// What the dashboard says needs the operator on a System: each open Condition
// with the evidence behind it, each recorded file the Collector could not read,
// and each set of checks or runs that stopped arriving while the System still
// reports. Times are epoch milliseconds.

import type { Disk, JobRun, ScheduleEntry, ServiceCheck } from './system-detail-types.ts';

// Evidence older than this is old: two missed hourly resends of a check set or
// run set.
export const OLD_EVIDENCE_MS = 2 * 60 * 60_000;

// How far an item's evidence holds: `current` when the check, run, or sample it
// rests on arrived within OLD_EVIDENCE_MS, or the Condition is about silence
// itself; `old` when it arrived longer ago, or never; `unknown` when the latest
// check could not tell, such as a file the Collector could not read or a files
// record the checks did not judge in the version the Hub mirrors. Only
// `current` evidence confirms a failure.
export type Evidence = 'current' | 'old' | 'unknown';

// What names a Service to its supervisor: a systemd unit, a launchd label, or a
// Docker container; undefined for a Service with no supervisor.
export type ServiceTarget = {
  // The loopback URL its health check asks, when the record names one.
  health: string | undefined;
  supervisor: string;
  target: string | undefined;
};

// What names a job to its scheduler: a launchd label or a systemd timer unit.
export type JobTarget = { scheduler: string; target: string };

export type AttentionFacts =
  | {
      kind: 'drift';
      // The files record that holds the path, and the hash it records, when
      // the Hub still mirrors one.
      record: string | undefined;
      sha256: string | undefined;
      // How many other files in that record the latest checks found matching.
      othersMatching: number;
      // How the latest checks found the file; undefined when they list it no
      // longer, so it matched when last checked.
      state: 'drifted' | 'missing' | 'unreadable' | undefined;
    }
  | {
      kind: 'service_down';
      // The Service's latest checks, supervisor first.
      checks: ServiceCheck[];
      reason: string;
      service: ServiceTarget | undefined;
    }
  | { kind: 'job_failing'; job: JobTarget | undefined; latestRun: JobRun | undefined }
  | {
      kind: 'job_overdue';
      job: JobTarget | undefined;
      // The latest successful run, undefined when the job never succeeded.
      latestSuccess: JobRun | undefined;
      reason: string;
      schedule: ScheduleEntry[];
    }
  // The mount's newest Vitals, undefined when the newest sample lacks it.
  | { disk: Disk | undefined; kind: 'low_disk'; reason: string }
  | { kind: 'reports_rejected'; reason: string }
  | { kind: 'system_stale'; lastSeenAt: number | undefined; reason: string; sleeps: boolean }
  // A recorded file in a files record the latest checks judged, which the
  // Collector could not read. The Hub raises no Condition for it.
  | { kind: 'file_unreadable'; record: string; sha256: string | undefined }
  // The System still reports, but its check set (Service and file checks) or
  // run set (job runs) has not arrived for over OLD_EVIDENCE_MS.
  | { kind: 'checks_missing'; set: 'checks' | 'runs' };

export type AttentionKind = AttentionFacts['kind'];

export type Attention = AttentionFacts & {
  // When the check, run, sample, or rejection the item rests on arrived:
  // check_sets or run_sets received_at for Services, files, and jobs; the
  // newest Vitals sample for low disk; last seen for a stale System; the latest
  // rejection for Reports rejected. Undefined when none has arrived.
  checkedAt: number | undefined;
  evidence: Evidence;
  // When it was first detected: the Condition's raised_at, the unreadable
  // file's since, or when the missing set became old.
  firstDetected: number;
  // The Condition's subject: a file path, Service, job, or mount; '' for one
  // about the whole System. A file's path for file_unreadable; '' for
  // checks_missing.
  subject: string;
  system: string;
  // Whether the System it is on is no longer paired.
  unpaired: boolean;
};
