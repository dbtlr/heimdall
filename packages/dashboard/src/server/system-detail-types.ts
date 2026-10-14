// The data the System detail page renders: one System's Vitals, Harness
// processes, agent Sessions, and Conditions on one time axis; the sample the
// inspector shows; and what its provisioner recorded with its Timeline. Times
// are epoch milliseconds.

import type {
  ConditionKind,
  ConditionMark,
  CpuBucket,
  Gap,
  LaneStatus,
  Link,
  Range,
} from './fleet-overview-types.ts';

// One 5-minute Vitals rollup bucket, starting at `t`: memory used on average,
// and the memory the System had.
export type MemoryBucket = { t: number; totalBytes: number; usedBytes: number };

// One Harness process over the window: the CPU cores its process tree kept
// busy in each 5-minute bucket, null where the bucket before is missing.
export type ProcessSeries = {
  harness: string;
  pid: number;
  points: { cores: number | null; t: number }[];
  processId: number;
  project: string | undefined;
};

// One agent Session over the window, with each stretch of it that falls in it.
export type SessionRow = {
  branch: string | undefined;
  // The Session's cost at list price, undefined when any request is unpriced.
  costUsd: number | undefined;
  harness: string;
  project: string | undefined;
  sessionId: string;
  source: string;
  stretches: { endedAt: number; link: Link; startedAt: number }[];
};

// One mount of the newest Vitals sample.
export type Disk = { mount: string; totalBytes: number; usedBytes: number };

// One install of a Harness: which, its version, and the kind of place the
// Collector found it in, such as npm or native.
export type HarnessInstall = { harness: string; location: string; version: string };

export type SystemDetail = {
  // The Collector's version, undefined until a Report from it is stored.
  collectorVersion: string | undefined;
  conditions: ConditionMark[];
  cpu: CpuBucket[];
  from: number;
  gaps: Gap[];
  // Each installed Harness, as the Collector last found them: empty for a
  // Collector that found none, undefined for one that never said.
  harnesses: HarnessInstall[] | undefined;
  lastSeenAt: number | undefined;
  // The newest Vitals sample, undefined for a System that never sent one.
  latest:
    | {
        cpuBusyPercent: number;
        disks: Disk[];
        // Load averages over 1, 5, and 15 minutes.
        load: [number, number, number];
        memoryTotalBytes: number;
        memoryUsedBytes: number;
        t: number;
        uptimeSeconds: number;
      }
    | undefined;
  memory: MemoryBucket[];
  name: string;
  now: number;
  // Whether the System still holds a token. An unpaired System keeps its
  // history, and its page says so in a banner.
  paired: boolean;
  // The Collector's operating system and architecture, such as linux and x64.
  platform: { arch: string; os: string } | undefined;
  processes: ProcessSeries[];
  range: Range;
  sessions: SessionRow[];
  sleeps: boolean;
  status: LaneStatus;
  to: number;
};

// A Harness process running at the inspected sample, with the Sessions the Hub
// links to it then, and the requests it answered in the sample.
export type SampleProcess = {
  // CPU cores the process tree kept busy since its reading before.
  cores: number | undefined;
  harness: string;
  pid: number;
  processId: number;
  project: string | undefined;
  requests: number;
  rssBytes: number | undefined;
  sessions: { branch: string | undefined; project: string | undefined }[];
};

// A Session working at the sample that the Hub could not link to one process.
export type UnlinkedSession = {
  branch: string | undefined;
  // How many processes it could have been, for an ambiguous one.
  candidates: number;
  harness: string;
  link: Exclude<Link, 'linked'>;
  project: string | undefined;
  requests: number;
  sessionId: string;
};

// The raw Vitals sample nearest the time asked for, as the inspector shows it.
export type SampleInspection = {
  // The 5-minute bucket that holds the sample: CPU busy average and high.
  bucket: { average: number; high: number } | undefined;
  cpuBusyPercent: number;
  load1: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  processes: SampleProcess[];
  t: number;
  unlinked: UnlinkedSession[];
};

export type ServiceCheck = {
  check: string;
  detail: string;
  since: number;
  state: string;
};

export type RecordedService = {
  checks: ServiceCheck[];
  name: string;
  // The supervisor the record names: systemd, launchd, docker, or none.
  supervisor: string;
};

export type JobRun = { exitStatus: number; finished: number; started: number };

export type ScheduleEntry = {
  day?: number;
  hour?: number;
  minute?: number;
  month?: number;
  weekday?: number;
};

export type RecordedJob = {
  latestRun: JobRun | undefined;
  name: string;
  // The job Conditions open on it now.
  open: Extract<ConditionKind, 'job_failing' | 'job_overdue'>[];
  schedule: ScheduleEntry[];
};

// A recorded file the Collector found not matching its record.
export type FileIssue = { path: string; since: number; state: string };

export type RecordedFiles = {
  // Whether the latest checks judged the version of the record the Hub
  // mirrors; until they do, its files are neither matching nor Drift.
  checked: boolean;
  count: number;
  issues: FileIssue[];
  name: string;
};

export type RecordedApplication = {
  name: string;
  provenance: { by: string; revision: string | undefined } | undefined;
  source: string | undefined;
  version: string;
};

export type Recorded = {
  applications: RecordedApplication[];
  files: RecordedFiles[];
  jobs: RecordedJob[];
  services: RecordedService[];
};

// One Condition on the Timeline.
export type TimelineEntry = {
  clearedAt: number | undefined;
  kind: ConditionKind;
  raisedAt: number;
  reason: string;
  subject: string;
};

export type SystemRecords = { recorded: Recorded; timeline: TimelineEntry[] };
