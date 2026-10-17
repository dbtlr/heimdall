import {
  ConditionLevelSchema,
  FUTURE_SAMPLE_TOLERANCE_MS,
  UpdateManagerSchema,
  updateSourceSubject,
  RebootObservationSchema,
  freshUpdateTime,
  UPDATE_OBSERVATION_MAX_AGE_MS,
  UPDATE_METADATA_MAX_AGE_MS,
} from '@heimdall/schema';
import type { UpdateManager, RebootObservation } from '@heimdall/schema';
import type { SQL } from 'bun';

import { OLD_EVIDENCE_MS } from './attention-types.ts';
import type {
  Attention,
  AttentionFacts,
  Evidence,
  JobTarget,
  ServiceTarget,
} from './attention-types.ts';
import {
  bySystem,
  byCheck,
  conditionKind,
  field,
  filesOf,
  judgedFilesRecords,
  scheduleOf,
  text,
  toRun,
} from './hub-rows.ts';
import type { ChecksRow, RecordRow, RunRow } from './hub-rows.ts';
import type { Disk } from './system-detail-types.ts';

type ConditionRow = {
  id: string;
  kind: string;
  level: string;
  latest_at: Date;
  latest_reason: string;
  raised_at: Date;
  subject: string;
  system: string;
};

type ObservationRow = { system: string; observation: unknown };

type ChecksSetRow = ChecksRow & { received_at: Date; system: string };

type RunSetRow = { received_at: Date; system: string };

type MirroredRunRow = RunRow & {
  latest_success: RunRow['latest_run'] | null;
  system: string;
};

type MirroredRecordRow = RecordRow & { system: string };

type SystemRow = { last_seen_at: Date | null; sleeps: boolean | null; system: string };

type SampleRow = {
  disks: Disk[];
  system: string;
  t: Date;
  cpu_known: boolean | null;
  memory_known: boolean | null;
  process_coverage: unknown;
};

// Everything the Hub holds about one System that bears on what needs the operator.
type Held = {
  checks: ChecksSetRow | undefined;
  conditions: ConditionRow[];
  jobRuns: Map<string, MirroredRunRow>;
  lastSeenAt: number | undefined;
  records: MirroredRecordRow[];
  runSet: RunSetRow | undefined;
  sample: SampleRow | undefined;
  sleeps: boolean;
  updateManagers: UpdateManager[];
  reboot: RebootObservation | undefined;
};

// What the item rests on and how far that holds, with the facts of its kind.
type Found = {
  checkedAt: number | undefined;
  evidence: Evidence;
  facts: Exclude<AttentionFacts, { kind: 'checks_missing' | 'file_unreadable' }>;
};

// Where an item is: the System it is on, and whether that System is unpaired.
type Place = { system: string; unpaired: boolean };

type FileState = Extract<AttentionFacts, { kind: 'drift' }>['state'];

const isFileState = (state: string | undefined): state is FileState =>
  state === 'drifted' || state === 'missing' || state === 'unreadable';

// Whether evidence that arrived at `checkedAt` is old at `now`; evidence that
// never arrived is old.
const isOld = (checkedAt: number | undefined, now: number) =>
  checkedAt === undefined || now - checkedAt > OLD_EVIDENCE_MS;

// The evidence of an item resting on a check that arrived at `checkedAt`: old
// when that is long ago, else `otherwise`.
const evidenceAt = (checkedAt: number | undefined, now: number, otherwise: Evidence): Evidence =>
  isOld(checkedAt, now) ? 'old' : otherwise;

// The record of kind `kind` named `name`.
const recordOf = (held: Held, kind: string, name: string) =>
  held.records.find((row) => row.kind === kind && row.name === name)?.record;

// The field of a Service record that names it to each kind of supervisor.
const NAMED_BY: Record<string, string> = {
  docker: 'container',
  launchd: 'label',
  systemd: 'unit',
  'systemd-user': 'unit',
};

// What names a Service to its supervisor, from its mirrored record.
const serviceTarget = (record: Record<string, unknown> | undefined): ServiceTarget | undefined => {
  if (record === undefined) {
    return undefined;
  }
  const supervisor = text(record.supervisor) ?? 'none';
  const key = NAMED_BY[supervisor];
  return {
    health: text(record.health),
    supervisor,
    target: key === undefined ? undefined : text(record[key]),
  };
};

// What names a job to its scheduler, from its mirrored record.
const jobTarget = (record: Record<string, unknown> | undefined): JobTarget | undefined => {
  const scheduler = text(record?.scheduler);
  const target = text(record?.label) ?? text(record?.unit);
  return scheduler === undefined || target === undefined ? undefined : { scheduler, target };
};

// The files record that holds `path`: the one the check names when the Hub
// mirrors it, else the first by name that does.
const recordHolding = (held: Held, path: string, named: string | undefined) => {
  const holds = (row: MirroredRecordRow) =>
    row.kind === 'files' && filesOf(row.record.files).some((file) => file.path === path);
  return held.records.find((row) => row.name === named && holds(row)) ?? held.records.find(holds);
};

const driftFacts = (
  held: Held,
  judged: ReadonlySet<string>,
  subject: string,
  now: number,
): Found => {
  const checkedAt = held.checks?.received_at.getTime();
  const entry = held.checks?.files?.find((file) => file.path === subject);
  const checked = entry?.state;
  const state = isFileState(checked) ? checked : undefined;
  const holder = recordHolding(held, subject, entry?.record);
  const listed = filesOf(holder?.record.files);
  // As in the Hub's Drift rule, the checks speak for the file only when they
  // judged the version of its record the Hub mirrors.
  const isJudged = holder !== undefined && judged.has(holder.name);
  const others = listed.filter(({ path }) => path !== subject).length;
  const othersFailing = (held.checks?.files ?? []).filter(
    (file) => file.record === holder?.name && file.path !== subject,
  ).length;
  return {
    checkedAt,
    evidence: evidenceAt(
      checkedAt,
      now,
      isJudged && state !== 'unreadable' ? 'current' : 'unknown',
    ),
    facts: {
      kind: 'drift',
      othersMatching: isJudged ? Math.max(0, others - othersFailing) : 0,
      record: holder?.name,
      sha256: listed.find((file) => file.path === subject)?.sha256,
      state,
    },
  };
};

const serviceDownFacts = (held: Held, row: ConditionRow, now: number): Found => {
  const checkedAt = held.checks?.received_at.getTime();
  const checks = (held.checks?.services ?? [])
    .filter((check) => check.service === row.subject)
    .map(({ check, detail, since, state }) => ({ check, detail, since, state }))
    .toSorted(byCheck);
  const confirmed = checks.some(({ state }) => state === 'stopped' || state === 'unhealthy');
  return {
    checkedAt,
    evidence: evidenceAt(checkedAt, now, confirmed ? 'current' : 'unknown'),
    facts: {
      checks,
      kind: 'service_down',
      reason: row.latest_reason,
      service: serviceTarget(recordOf(held, 'service', row.subject)),
    },
  };
};

const jobFacts = (held: Held, row: ConditionRow, now: number): Found => {
  const checkedAt = held.runSet?.received_at.getTime();
  const runs = held.jobRuns.get(row.subject);
  const record = recordOf(held, 'job', row.subject);
  const job = jobTarget(record);
  const facts: AttentionFacts =
    row.kind === 'job_failing'
      ? {
          job,
          kind: 'job_failing',
          latestRun: runs === undefined ? undefined : toRun(runs.latest_run),
        }
      : {
          job,
          kind: 'job_overdue',
          latestSuccess: runs?.latest_success == null ? undefined : toRun(runs.latest_success),
          reason: row.latest_reason,
          schedule: scheduleOf(record?.schedule),
        };
  return { checkedAt, evidence: evidenceAt(checkedAt, now, 'current'), facts };
};

const lowDiskFacts = (held: Held, row: ConditionRow, now: number): Found => ({
  checkedAt: held.sample?.t.getTime(),
  evidence: evidenceAt(held.sample?.t.getTime(), now, 'current'),
  facts: {
    disk: held.sample?.disks
      .filter(({ mount }) => mount === row.subject)
      .map(({ mount, totalBytes, usedBytes }): Disk => ({ mount, totalBytes, usedBytes }))[0],
    kind: 'low_disk',
    reason: row.latest_reason,
  },
});

// Update evidence uses the package query and repository metadata, never Vitals.
const updateFacts = (held: Held, row: ConditionRow, now: number): Found => {
  const kind = conditionKind(row.kind);
  if (kind === 'reboot_required') {
    const observation = held.reboot;
    const checkedAt = observation?.observedAt;
    let evidence: Evidence =
      observation?.kind === 'available' && observation.required ? 'current' : 'unknown';
    if (
      checkedAt === undefined ||
      !freshUpdateTime(checkedAt, now, UPDATE_OBSERVATION_MAX_AGE_MS)
    ) {
      evidence = 'old';
    }
    return {
      checkedAt,
      evidence,
      facts: { kind, reason: row.latest_reason },
    };
  }
  const observation = held.updateManagers.find(
    (manager) => updateSourceSubject(manager) === row.subject,
  );
  const checkedAt = observation?.observedAt;
  let evidence: Evidence = 'unknown';
  if (checkedAt === undefined || !freshUpdateTime(checkedAt, now, UPDATE_OBSERVATION_MAX_AGE_MS)) {
    evidence = 'old';
  } else if (observation?.result.kind === 'available') {
    const { metadataAt, updates } = observation.result;
    if (metadataAt === null || !freshUpdateTime(metadataAt, now, UPDATE_METADATA_MAX_AGE_MS)) {
      evidence = 'old';
    } else if (updates.length > 0) {
      evidence = 'current';
    }
  }
  return { checkedAt, evidence, facts: { kind: 'pending_update', reason: row.latest_reason } };
};

// The facts and evidence behind an open Condition, by its kind.
const conditionFound = (
  held: Held,
  judged: ReadonlySet<string>,
  row: ConditionRow,
  now: number,
): Found => {
  const kind = conditionKind(row.kind);
  if (kind === 'pending_update' || kind === 'reboot_required') {
    return updateFacts(held, row, now);
  }
  if (kind === 'drift') {
    return driftFacts(held, judged, row.subject, now);
  }
  if (kind === 'service_down') {
    return serviceDownFacts(held, row, now);
  }
  if (kind === 'job_failing' || kind === 'job_overdue') {
    return jobFacts(held, row, now);
  }
  if (kind === 'low_disk') {
    return lowDiskFacts(held, row, now);
  }
  if (kind === 'high_cpu' || kind === 'high_memory') {
    const checkedAt = held.sample?.t.getTime();
    const unknown =
      (kind === 'high_cpu' ? held.sample?.cpu_known : held.sample?.memory_known) !== true;
    return {
      checkedAt,
      evidence: evidenceAt(checkedAt, now, unknown ? 'unknown' : 'current'),
      facts: { kind, reason: row.latest_reason },
    };
  }
  if (kind === 'hot_process') {
    const checkedAt = held.sample?.t.getTime();
    const known = field(held.sample?.process_coverage, row.subject) === true;
    return {
      checkedAt,
      evidence: evidenceAt(checkedAt, now, known ? 'current' : 'unknown'),
      facts: { kind, reason: row.latest_reason },
    };
  }
  if (kind === 'system_stale') {
    return {
      checkedAt: held.lastSeenAt,
      evidence: 'current',
      facts: {
        kind,
        lastSeenAt: held.lastSeenAt,
        reason: row.latest_reason,
        sleeps: held.sleeps,
      },
    };
  }
  return {
    checkedAt: row.latest_at.getTime(),
    evidence: 'current',
    facts: { kind, reason: row.latest_reason },
  };
};

// One item per recorded file in a judged files record that the Collector could
// not read and that no open Drift Condition covers.
const unreadableItems = (
  held: Held,
  judged: ReadonlySet<string>,
  now: number,
  place: Place,
): Attention[] => {
  const checkedAt = held.checks?.received_at.getTime();
  const drifting = new Set(
    held.conditions.filter(({ kind }) => kind === 'drift').map(({ subject }) => subject),
  );
  return (held.checks?.files ?? [])
    .filter(
      (file) => file.state === 'unreadable' && judged.has(file.record) && !drifting.has(file.path),
    )
    .map((file): Attention => ({
      checkedAt,
      evidence: evidenceAt(checkedAt, now, 'unknown'),
      firstDetected: file.since,
      kind: 'file_unreadable',
      record: file.record,
      sha256: filesOf(recordOf(held, 'files', file.record)?.files).find(
        ({ path }) => path === file.path,
      )?.sha256,
      subject: file.path,
      system: place.system,
      unpaired: place.unpaired,
    }));
};

// An item for a set that stopped arriving while the System kept reporting.
// Only a System whose provisioner recorded something the set judges is waiting
// for it.
const missingItem = (held: Held, set: 'checks' | 'runs', place: Place): Attention[] => {
  const receivedAt = (set === 'checks' ? held.checks : held.runSet)?.received_at.getTime();
  const judges = set === 'checks' ? ['service', 'files'] : ['job'];
  if (
    receivedAt === undefined ||
    held.lastSeenAt === undefined ||
    held.lastSeenAt - receivedAt <= OLD_EVIDENCE_MS ||
    !held.records.some(({ kind }) => judges.includes(kind))
  ) {
    return [];
  }
  return [
    {
      ...place,
      checkedAt: receivedAt,
      evidence: 'old',
      firstDetected: receivedAt + OLD_EVIDENCE_MS,
      kind: 'checks_missing',
      set,
      subject: '',
    },
  ];
};

// Every item for one System: its open Conditions, its unreadable files, and
// its missing sets, in no order.
const itemsOf = async (held: Held, place: Place, now: number): Promise<Attention[]> => {
  const judged = await judgedFilesRecords(held.checks, held.records);
  const fromConditions = held.conditions.map((row): Attention => {
    const { checkedAt, evidence, facts } = conditionFound(held, judged, row, now);
    return {
      ...facts,
      ...place,
      checkedAt,
      conditionId: row.id,
      evidence,
      firstDetected: row.raised_at.getTime(),
      level: ConditionLevelSchema.parse(row.level),
      subject: row.subject,
    };
  });
  return [
    ...fromConditions,
    ...unreadableItems(held, judged, now, place),
    ...missingItem(held, 'checks', place),
    ...missingItem(held, 'runs', place),
  ];
};

// Newest first detected first, paired Systems before unpaired ones.
const byAttention = (a: Attention, b: Attention) =>
  Number(a.unpaired) - Number(b.unpaired) || b.firstDetected - a.firstDetected;

const heldOf = (
  name: string,
  rows: {
    checks: Map<string, ChecksSetRow[]>;
    conditions: Map<string, ConditionRow[]>;
    records: Map<string, MirroredRecordRow[]>;
    runs: Map<string, MirroredRunRow[]>;
    runSets: Map<string, RunSetRow[]>;
    samples: Map<string, SampleRow[]>;
    systems: Map<string, SystemRow[]>;
    updateManagers: Map<string, ObservationRow[]>;
    reboots: Map<string, ObservationRow[]>;
  },
): Held => ({
  checks: rows.checks.get(name)?.[0],
  conditions: rows.conditions.get(name) ?? [],
  jobRuns: new Map((rows.runs.get(name) ?? []).map((row) => [row.job, row])),
  lastSeenAt: rows.systems.get(name)?.[0]?.last_seen_at?.getTime(),
  reboot: rows.reboots
    .get(name)
    ?.map(({ observation }) => RebootObservationSchema.parse(observation))[0],
  records: rows.records.get(name) ?? [],
  runSet: rows.runSets.get(name)?.[0],
  sample: rows.samples.get(name)?.[0],
  sleeps: rows.systems.get(name)?.[0]?.sleeps === true,
  updateManagers: (rows.updateManagers.get(name) ?? []).map(({ observation }) =>
    UpdateManagerSchema.parse(observation),
  ),
});

// Everything that needs the operator on `systems`, with the evidence behind
// each item, as of `now`: each open Condition, each recorded file the
// Collector could not read, and each set of checks or runs that stopped
// arriving while the System still reports. Newest first detected first, those
// on paired Systems before those on unpaired ones. Read-only.
export const readAttention = async (
  sql: SQL,
  { now, systems }: { now: number; systems: readonly { name: string; paired: boolean }[] },
): Promise<Attention[]> => {
  if (systems.length === 0) {
    return [];
  }
  const names = systems.map(({ name }) => name);
  const [conditions, checks, runSets, runs, records, held, samples, updateManagers, reboots]: [
    ConditionRow[],
    ChecksSetRow[],
    RunSetRow[],
    MirroredRunRow[],
    MirroredRecordRow[],
    SystemRow[],
    SampleRow[],
    ObservationRow[],
    ObservationRow[],
  ] = await Promise.all([
    sql`
      SELECT id, system, kind, level, subject, raised_at, latest_at, latest_reason
      FROM conditions
      WHERE system IN ${sql(names)} AND cleared_at IS NULL
    `,
    sql`
      SELECT system, received_at, files, file_records, services
      FROM check_sets WHERE system IN ${sql(names)}
    `,
    sql`SELECT system, received_at FROM run_sets WHERE system IN ${sql(names)}`,
    sql`
      SELECT system, job, latest_run, latest_success
      FROM mirrored_runs WHERE system IN ${sql(names)}
    `,
    sql`
      SELECT system, kind, name, record
      FROM mirrored_records WHERE system IN ${sql(names)}
      ORDER BY kind, name
    `,
    sql`SELECT name AS system, last_seen_at, sleeps FROM systems WHERE name IN ${sql(names)}`,
    // One newest sample per System, read through the (system, t) key.
    sql`
      SELECT s.name AS system, v.t, v.disks, e.cpu_known, e.memory_known,
             p.coverage AS process_coverage
      FROM systems s
      CROSS JOIN LATERAL (
        SELECT t, disks FROM vitals_samples
        WHERE system = s.name AND t <= ${new Date(now + FUTURE_SAMPLE_TOLERANCE_MS)}
        ORDER BY t DESC LIMIT 1
      ) v
      LEFT JOIN load_evaluations e ON e.system = s.name AND e.through = v.t
      LEFT JOIN hot_process_evaluations p ON p.system = s.name AND p.through = v.t
      WHERE s.name IN ${sql(names)}
    `,
    sql`SELECT system, observation FROM update_managers WHERE system IN ${sql(names)}`,
    sql`SELECT system, observation FROM reboot_observations WHERE system IN ${sql(names)}`,
  ]);
  const grouped = {
    checks: bySystem(checks),
    conditions: bySystem(conditions),
    reboots: bySystem(reboots),
    records: bySystem(records),
    runSets: bySystem(runSets),
    runs: bySystem(runs),
    samples: bySystem(samples),
    systems: bySystem(held),
    updateManagers: bySystem(updateManagers),
  };
  const items = await Promise.all(
    systems.map(({ name, paired }) =>
      itemsOf(heldOf(name, grouped), { system: name, unpaired: !paired }, now),
    ),
  );
  return items.flat().toSorted(byAttention);
};
