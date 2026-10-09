import { z } from 'zod';

import { TranscriptsSectionSchema } from './transcripts.ts';
import { bytes, epochMs } from './values.ts';

// The Report wire schema version this build speaks. The Hub rejects versions it
// does not know. Bump it only for a rename, a removal, or a change of meaning;
// new optional fields keep the version (ADR-0004).
export const REPORT_SCHEMA_VERSION = 1;

// Fleet's System name: a DNS label, matching Fleet's own validation.
export const SYSTEM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

// About four hours of 15-second samples. The Collector splits a longer
// backlog into several Reports.
export const MAX_SAMPLES_PER_REPORT = 1000;

// Checks catch Collector bugs, not operating-system quirks: used may exceed
// total and percentages may exceed 100, so neither is bounded (ADR-0004).
const amount = z.number().nonnegative();

const DiskSchema = z.object({ mount: z.string().min(1), totalBytes: bytes, usedBytes: bytes });

// One Vitals sample: the System's host measurements and the Collector's own
// footprint at one moment. CPU percentages span all cores and average the
// interval since the previous sample.
export const VitalsSampleSchema = z.object({
  collector: z.object({ cpuPercent: amount, rssBytes: bytes }),
  cpu: z.object({ busyPercent: amount }),
  disks: z.array(DiskSchema).min(1),
  load: z.tuple([amount, amount, amount]),
  memory: z.object({ totalBytes: bytes, usedBytes: bytes }),
  t: epochMs,
  uptimeSeconds: amount,
});

const isStrictlyIncreasing = (samples: { t: number }[]) =>
  samples.every((sample, i) => i === 0 || sample.t > (samples[i - 1]?.t ?? -1));

// One Report a Collector pushes to the Hub's ingest endpoint. Samples are keyed
// by System and `t`, so the Hub skips any it already holds. The Hub answers an
// invalid Report with 422, the one answer on which the Collector drops it
// (ADR-0004).
export const ReportSchema = z.object({
  collector: z.object({
    arch: z.string().min(1),
    platform: z.enum(['darwin', 'linux']),
    version: z.string().min(1),
  }),
  samples: z
    .array(VitalsSampleSchema)
    .min(1)
    .max(MAX_SAMPLES_PER_REPORT)
    .refine(isStrictlyIncreasing, { message: 'sample times must strictly increase' }),
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  sentAt: epochMs,
  // The Hub rejects a Report whose System differs from its ingest token's.
  system: z.string().regex(SYSTEM_NAME),
  // In every Report; optional for Collectors that predate it (ADR-0013).
  transcripts: TranscriptsSectionSchema.optional(),
});

export type VitalsSample = z.infer<typeof VitalsSampleSchema>;
export type Report = z.infer<typeof ReportSchema>;
