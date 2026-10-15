import { z } from 'zod';

import { bytes } from './values.ts';

export const MAX_PROCESS_CENSUS = 4096;
export const MAX_TOP_PROCESSES = 5;

const ProcessIdentitySchema = z.object({
  bootId: z.string().min(1).max(128),
  name: z.string().min(1).max(1024),
  pid: z.int().positive(),
  start: z.string().regex(/^\d+$/u).max(32),
});

const ProcessReadingSchema = ProcessIdentitySchema.omit({ bootId: true }).extend({
  cpuCores: z.number().nonnegative(),
  rssBytes: bytes,
});

const CompleteCensusSchema = z.object({
  kind: z.literal('complete'),
  presentPids: z.array(ProcessIdentitySchema.shape.pid).max(MAX_PROCESS_CENSUS),
  remainderMaxCores: z.number().nonnegative(),
  unknownPids: z.array(ProcessIdentitySchema.shape.pid).max(MAX_PROCESS_CENSUS),
});
const PartialCensusSchema = z.object({ kind: z.literal('partial') });
const CensusSchema = z.discriminatedUnion('kind', [CompleteCensusSchema, PartialCensusSchema]);

// Contradictory census evidence cannot both observe a process and declare it exited.
export const ProcessObservationSchema = z
  .object({
    bootId: ProcessIdentitySchema.shape.bootId,
    census: CensusSchema,
    intervalMs: z.number().nonnegative().max(15_000),
    top: z.array(ProcessReadingSchema).max(MAX_TOP_PROCESSES),
  })
  .refine((observation) => {
    const top = new Set(observation.top.map((entry) => entry.pid));
    if (top.size !== observation.top.length) {
      return false;
    }
    if (observation.census.kind === 'partial') {
      return true;
    }
    const present = new Set(observation.census.presentPids);
    const unknown = new Set(observation.census.unknownPids);
    return (
      [...top].every((pid) => present.has(pid) && !unknown.has(pid)) &&
      [...unknown].every((pid) => present.has(pid))
    );
  });

export type ProcessObservation = z.infer<typeof ProcessObservationSchema>;
type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;

export const processSubject = ({ bootId, pid, start, name }: ProcessIdentity): string =>
  JSON.stringify([bootId, pid, start, name]);

export const parseProcessSubject = (subject: string): ProcessIdentity | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(subject);
  } catch {
    return undefined;
  }
  const tuple = z
    .tuple([
      ProcessIdentitySchema.shape.bootId,
      ProcessIdentitySchema.shape.pid,
      ProcessIdentitySchema.shape.start,
      ProcessIdentitySchema.shape.name,
    ])
    .safeParse(value);
  if (!tuple.success) {
    return undefined;
  }
  const [bootId, pid, start, name] = tuple.data;
  return { bootId, name, pid, start };
};
