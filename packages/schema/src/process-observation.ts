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
// shared pages in every process that maps them.
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
// census claim, so it is valid with a partial census or a zero interval. A
// malformed list drops only itself: it feeds a display, so it must not cost the
// CPU evidence hot-process judgment depends on.
export const ProcessObservationSchema = z
  .object({
    bootId: ProcessIdentitySchema.shape.bootId,
    census: CensusSchema,
    intervalMs: z.number().nonnegative().max(15_000),
    top: z.array(ProcessReadingSchema).max(MAX_TOP_PROCESSES),
    // oxlint-disable-next-line promise/prefer-await-to-then -- zod's catch, not a promise's.
    topByMemory: TopByMemorySchema.optional().catch(undefined),
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
