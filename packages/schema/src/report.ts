import { z } from 'zod';

import { ChecksSectionSchema } from './checks-section.ts';
import { RecordsSectionSchema } from './records-section.ts';
import { RunsSectionSchema } from './runs-section.ts';
import { TranscriptsSectionSchema } from './transcripts.ts';
import { bytes, epochMs } from './values.ts';

// The Report wire schema version this build speaks. The Hub rejects versions it
// does not know. Bump it only for a rename, a removal, or a change of meaning;
// new optional fields keep the version (ADR-0004).
export const REPORT_SCHEMA_VERSION = 1;

// Fleet's System name: a DNS label, matching Fleet's own validation.
export const SYSTEM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

// How often a Collector takes a Vitals sample while its System is awake. The
// Hub counts a System's awake time from the samples it stored.
export const SAMPLE_INTERVAL_MS = 15_000;

// About four hours of 15-second samples. The Collector splits a longer
// backlog into several Reports.
export const MAX_SAMPLES_PER_REPORT = 1000;

// The largest Report body the Hub reads; a larger one is rejected, Vitals with
// it. The records section may take 8 MiB, the runs section 1 MiB, and the
// checks section 1 MiB, leaving 2 MiB for the samples and transcripts: 1,000
// samples of 24 disks each come to about 2.2 MB. Disks per sample are not
// bounded, so a Collector sends a Report that would exceed this without its
// sections.
export const MAX_REPORT_BYTES = 12 * 1024 * 1024;

// An IANA time zone name such as `America/New_York`, `UTC`, or `Etc/GMT+5`.
// Its shape is checked, not whether the zone exists, so a zone only a newer
// time zone database knows does not reject a Report (ADR-0004).
export const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/u;

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
  // Only when what the Collector observed against its records changed, it
  // started, or an hour passed; the Hub keeps the System's latest checks until
  // another arrives.
  checks: ChecksSectionSchema.optional(),
  collector: z.object({
    arch: z.string().min(1),
    platform: z.enum(['darwin', 'linux']),
    version: z.string().min(1),
  }),
  // Only when the Collector's record set changed, it started, or an hour
  // passed; the Hub keeps the System's mirror until another arrives (ADR-0011).
  records: RecordsSectionSchema.optional(),
  // Only when the latest runs of the Collector's jobs changed, it started, or
  // an hour passed; the Hub keeps the System's latest runs until another arrives.
  runs: RunsSectionSchema.optional(),
  samples: z
    .array(VitalsSampleSchema)
    .min(1)
    .max(MAX_SAMPLES_PER_REPORT)
    .refine(isStrictlyIncreasing, { message: 'sample times must strictly increase' }),
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  sentAt: epochMs,
  // Whether the System sleeps, as its collector.toml says. In every Report;
  // optional for Collectors that predate it, for which the Hub keeps what it
  // holds, and a System that never sent it counts as always on. A value that
  // is not a boolean is dropped like an absent one, so it never costs a Report
  // its Vitals (ADR-0004).
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod's catch, not a promise's.
  sleeps: z.boolean().optional().catch(undefined),
  // The Hub rejects a Report whose System differs from its ingest token's.
  system: z.string().regex(SYSTEM_NAME),
  // The System's time zone, in which its jobs' schedules are read. In every
  // Report; optional for Collectors that predate it. One this Hub cannot read is
  // dropped, so a Collector's looser idea of a zone never costs a Report its
  // Vitals (ADR-0004).
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod's catch, not a promise's.
  timeZone: z.string().regex(TIME_ZONE).optional().catch(undefined),
  // In every Report; optional for Collectors that predate it (ADR-0013).
  transcripts: TranscriptsSectionSchema.optional(),
});

export type VitalsSample = z.infer<typeof VitalsSampleSchema>;
export type Report = z.infer<typeof ReportSchema>;
