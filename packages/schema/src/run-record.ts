import { z } from 'zod';

import { unitName } from './fleet.ts';
import { versionedParser } from './versioned.ts';

// The run record schema version this build reads. Bump it only for a rename, a
// removal, or a change of meaning; new optional fields keep it.
export const RUN_RECORD_SCHEMA_VERSION = 1;

// An archive a run wrote, by its file name in the Backup Job's destination:
// printable ASCII without a slash, and neither `.` nor `..`, so it cannot
// name a path outside the destination.
const ArchiveSchema = z.object({
  name: z
    .string()
    .max(255)
    .regex(/^(?!\.\.?$)[ -.0-~]+$/u),
  sizeBytes: z.int().nonnegative(),
});

// Whole seconds, so the times compare exactly.
const run = {
  finishedAt: z.iso.datetime({ precision: 0 }),
  startedAt: z.iso.datetime({ precision: 0 }),
};

const finishesAfterStarting = <T extends { finishedAt: string; startedAt: string }>(
  schema: z.ZodType<T>,
) =>
  schema.refine(({ finishedAt, startedAt }) => Date.parse(finishedAt) >= Date.parse(startedAt), {
    message: 'a run finished before it started',
    // Only valid times can be compared.
    when: ({ issues }) => issues.length === 0,
  });

// One run, successful or not. A run that refused to start, such as when its
// volume was not mounted, still records its exit status and wrote no archive.
const RunSchema = finishesAfterStarting(
  z.object({
    ...run,
    archive: ArchiveSchema.nullable(),
    exitStatus: z.int().min(0).max(255),
  }),
);

const SuccessSchema = finishesAfterStarting(
  z.object({ ...run, archive: ArchiveSchema, exitStatus: z.literal(0) }),
);

type Run = z.infer<typeof RunSchema>;

const isSameRun = (a: Run, b: Run) =>
  a.startedAt === b.startedAt &&
  a.finishedAt === b.finishedAt &&
  a.exitStatus === b.exitStatus &&
  a.archive?.name === b.archive?.name &&
  a.archive?.sizeBytes === b.archive?.sizeBytes;

// The record a Backup Job keeps on its System of its latest run and its latest
// successful run (ADR-0010). Keeping both means a failure that follows a
// success cannot hide the success from a Collector that was not running in
// between. Readers drop fields they do not know, as for install records.
export const RunRecordSchema = z
  .object({
    latestRun: RunSchema,
    // Null until the Backup Job first succeeds.
    latestSuccess: SuccessSchema.nullable(),
    name: unitName,
    schemaVersion: z.literal(RUN_RECORD_SCHEMA_VERSION),
  })
  // The runner records a success as both runs, so the two never disagree.
  .refine(
    ({ latestRun, latestSuccess }) =>
      latestRun.exitStatus !== 0 || (latestSuccess !== null && isSameRun(latestRun, latestSuccess)),
    {
      message: 'a successful latest run must be the latest success',
      path: ['latestRun'],
      // Only valid runs can be compared.
      when: ({ issues }) => issues.length === 0,
    },
  )
  .meta({
    description:
      'The record a Backup Job keeps on its System of its latest run and its latest successful run (ADR-0010). Beyond this schema, Heimdall refuses a run that finished before it started and a successful latest run that is not the latest success. Fleet writes no field this schema does not name; a Collector reading a newer version of it drops the fields it does not know.',
    title: `Heimdall run record v${String(RUN_RECORD_SCHEMA_VERSION)}`,
  });

export type RunRecord = z.infer<typeof RunRecordSchema>;

export const parseRunRecord = versionedParser(RunRecordSchema, RUN_RECORD_SCHEMA_VERSION);
