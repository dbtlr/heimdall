import { z } from 'zod';

import { bytes, epochMs } from './values.ts';

// The most processes a Report's harnessProcesses section lists, running and
// ended together. At about 300 bytes each, the section stays under 150 KiB.
export const MAX_HARNESS_PROCESSES = 512;

const MAX_CWD_BYTES = 4096;

// One Harness root process, as the Collector saw it on its latest tick: a
// Harness process whose parent is not a process of the same Harness. The
// Harness is any short word, so a newer Collector's Harness does not reject a
// Report (ADR-0004). Only the executable's identity, the working directory, and
// totals travel; the schema drops any other field, so command-line arguments
// and environment variables cannot ride along (ADR-0002).
//
// `startedAt` and `pid` identify the process, since a pid is reused. `cwd` is
// null when the Collector could not read it. `cpuMicros` is the CPU time the
// process and its descendants have used, and `rssBytes` their resident memory
// at `lastSeenAt`; `peakRssBytes` is the highest `rssBytes` the Collector saw.
// A process still running has no `endedAt`. One that ended has the time of the
// tick that found it gone.
const HarnessProcessSchema = z.object({
  cpuMicros: z.int().nonnegative(),
  cwd: z.string().max(MAX_CWD_BYTES).nullable(),
  endedAt: epochMs.optional(),
  harness: z.string().min(1).max(64),
  lastSeenAt: epochMs,
  peakRssBytes: bytes,
  pid: z.int().positive(),
  rssBytes: bytes,
  startedAt: epochMs,
});

// A Report's harnessProcesses section: every Harness root process the Collector
// sees now, and those that ended and the Hub has not yet acknowledged. The Hub
// reads a running process it holds that the section no longer lists as ended
// while the Collector was not looking.
export const HarnessProcessesSectionSchema = z.object({
  processes: z.array(HarnessProcessSchema).max(MAX_HARNESS_PROCESSES),
});

export type HarnessProcess = z.infer<typeof HarnessProcessSchema>;
export type HarnessProcessesSection = z.infer<typeof HarnessProcessesSectionSchema>;
