import { z } from 'zod';

import { bytes } from './values.ts';

export const MAX_PROCESS_CENSUS = 4096;
export const MAX_TOP_PROCESSES = 5;
export const MAX_TOP_MEMORY_PROCESSES = 5;

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

// A process named for the memory it holds: its executable name and lifetime,
// validated as the CPU readings' are, and its resident bytes, which count
// shared pages in every process that maps them. The Collector only reads its
// recorded names for this list, so the list never changes CPU evidence.
const MemoryReadingSchema = ProcessIdentitySchema.omit({ bootId: true }).extend({
  rssBytes: bytes,
});

const distinctPids = (entries: readonly { pid: number }[]) =>
  new Set(entries.map((entry) => entry.pid)).size === entries.length;

const TopByMemorySchema = z
  .array(MemoryReadingSchema)
  .max(MAX_TOP_MEMORY_PROCESSES)
  .refine(distinctPids);

const CompleteCensusSchema = z.object({
  kind: z.literal('complete'),
  presentPids: z.array(ProcessIdentitySchema.shape.pid).max(MAX_PROCESS_CENSUS),
  remainderMaxCores: z.number().nonnegative(),
  unknownPids: z.array(ProcessIdentitySchema.shape.pid).max(MAX_PROCESS_CENSUS),
});
const PartialCensusSchema = z.object({ kind: z.literal('partial') });
const CensusSchema = z.discriminatedUnion('kind', [CompleteCensusSchema, PartialCensusSchema]);

// Contradictory census evidence cannot both observe a process and declare it exited.
// `topByMemory` is the processes holding the most resident memory, largest
// first. The Collector sends it on at most one sample a minute, so its absence
// means not reported, never no processes. It needs no CPU baseline and makes no
// census claim, so it is valid with a partial census or a zero interval. More
// than five entries, a repeated PID, or an invalid entry is a Collector bug and
// rejects the observation, as a malformed `top` does (ADR-0004).
export const ProcessObservationSchema = z
  .object({
    bootId: ProcessIdentitySchema.shape.bootId,
    census: CensusSchema,
    intervalMs: z.number().nonnegative().max(15_000),
    top: z.array(ProcessReadingSchema).max(MAX_TOP_PROCESSES),
    topByMemory: TopByMemorySchema.optional(),
  })
  .refine((observation) => {
    if (!distinctPids(observation.top)) {
      return false;
    }
    const top = new Set(observation.top.map((entry) => entry.pid));
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
