import { MAX_HARNESS_PROCESSES, SAME_HARNESS_PROCESS_MS } from '@heimdall/schema';
import type { HarnessProcess, HarnessProcessesSection } from '@heimdall/schema';

import { findHarnessRoots } from './roots.ts';
import type { ProcessEntry, ProcessReader } from './table.ts';

type Running = Omit<HarnessProcess, 'endedAt'>;
type Ended = HarnessProcess & { endedAt: number };

// A running process as the tracker holds it: the kernel's start it was first
// seen with, its tree's CPU time as read, the CPU time of nested roots that
// ended and moved into that reading, and the root whose tree it sits in.
type Tracked = {
  absorbedCpuMicros: number;
  enclosing: string | undefined;
  kernelStart: number | null;
  process: Running;
  readCpuMicros: number;
};

const keyOf = (process: { harness: string; pid: number }) =>
  `${process.harness}:${String(process.pid)}`;

// Whether a table entry is the process held under its pid.
const sameProcess = (held: Tracked, entry: ProcessEntry) =>
  held.kernelStart !== null && entry.kernelStart !== null
    ? held.kernelStart === entry.kernelStart
    : Math.abs(held.process.startedAt - entry.startedAt) <= SAME_HARNESS_PROCESS_MS;

// Watches the Harness root processes tick by tick and keeps the section that
// reports them: the ones running now, and the ones that ended, until the Hub
// acknowledges them.
//
// A tick reads the process table once (`reader.table`) and the working
// directory of each root. A process in the previous tick's table and not in
// this one ended at this tick's time, which is when the Collector noticed, not
// when the process exited. A process the Collector was not running to see end is
// the Hub's to close (see the spec).
//
// A pid read again is the same process when the kernel's start is the same
// (`kernelStart`), which no wall-clock step moves; a pid whose kernel start
// changed is a new process. When either read has no kernel start, a
// `startedAt` within SAME_HARNESS_PROCESS_MS is the same process. A process's
// `startedAt` is the one of the tick that first saw it, so a clock step later
// does not move it.
//
// Each CPU second counts once. A root nested in another root's tree reports
// its own tree, which the enclosing root leaves out. When the nested root ends
// and a reader's CPU time includes reaped children (`includesReaped`), its time
// moves into the enclosing root's reading, so the nested root's last reading is
// subtracted from the enclosing root's from then on. A nested root's CPU used
// between its last tick and its end still counts in the enclosing root.
//
// `latest` is undefined before the first tick, and a new object after each, so
// the reporter can tell by identity that a tick happened. A tick whose table
// cannot be read throws and changes nothing, so a failed read never ends a
// process. `settled` takes the section the Hub acknowledged and forgets the
// ended processes it carried; the next tick's section no longer lists them.
export const createProcessTracker = ({
  now,
  reader,
}: {
  now: () => number;
  reader: ProcessReader;
}) => {
  const running = new Map<string, Tracked>();
  let ended: Ended[] = [];
  let latest: HarnessProcessesSection | undefined;

  // The section lists at most MAX_HARNESS_PROCESSES, running and ended
  // together, so it always passes its own schema. Running processes come
  // first; the ended ones fill the room left, and the oldest are dropped. A
  // dropped end reaches the Hub as one it closes as missed.
  const rebuild = () => {
    const listed = [...running.values()]
      .map(({ process }) => process)
      .slice(0, MAX_HARNESS_PROCESSES);
    ended = ended.slice(Math.max(0, ended.length - (MAX_HARNESS_PROCESSES - listed.length)));
    latest = { processes: [...ended, ...listed] };
  };

  // Ends a process at `at`. Its CPU time moves into the enclosing root's
  // reading when the reader counts reaped children, so the enclosing root
  // subtracts it from now on.
  const end = (tracked: Tracked, at: number, next: Map<string, Tracked>) => {
    ended.push({ ...tracked.process, endedAt: at });
    const enclosing = tracked.enclosing === undefined ? undefined : next.get(tracked.enclosing);
    if (reader.includesReaped && enclosing !== undefined) {
      enclosing.absorbedCpuMicros += tracked.readCpuMicros;
    }
  };

  const rootsAt = async (at: number) => {
    const roots = findHarnessRoots(await reader.table());
    return Promise.all(
      roots.map(async (root) => ({ at, cwd: await reader.cwdOf(root.entry.pid), root })),
    );
  };

  return {
    latest: () => latest,
    settled: (delivered: HarnessProcessesSection) => {
      const gone = new Set(
        delivered.processes
          .filter((p) => p.endedAt !== undefined)
          .map((p) => `${keyOf(p)}:${String(p.startedAt)}`),
      );
      ended = ended.filter((p) => !gone.has(`${keyOf(p)}:${String(p.startedAt)}`));
    },
    tick: async () => {
      const at = now();
      const seen = await rootsAt(at);
      const next = new Map<string, Tracked>();
      const replaced: Tracked[] = [];
      for (const { cwd, root } of seen) {
        const { entry, harness } = root;
        const key = keyOf({ harness, pid: entry.pid });
        const held = running.get(key);
        const kept = held !== undefined && sameProcess(held, entry) ? held : undefined;
        if (held !== undefined && kept === undefined) {
          // The pid now belongs to another process.
          replaced.push(held);
        }
        const before = kept?.process;
        next.set(key, {
          absorbedCpuMicros: kept?.absorbedCpuMicros ?? 0,
          enclosing: root.enclosing === undefined ? undefined : keyOf(root.enclosing),
          kernelStart: kept === undefined ? entry.kernelStart : kept.kernelStart,
          process: {
            cpuMicros: root.cpuMicros,
            cwd: cwd ?? before?.cwd ?? null,
            harness,
            lastSeenAt: at,
            peakRssBytes: Math.max(before?.peakRssBytes ?? 0, root.rssBytes),
            pid: entry.pid,
            rssBytes: root.rssBytes,
            startedAt: before?.startedAt ?? entry.startedAt,
          },
          readCpuMicros: root.cpuMicros,
        });
      }
      for (const tracked of replaced) {
        end(tracked, at, next);
      }
      for (const [key, tracked] of running) {
        if (!next.has(key)) {
          end(tracked, at, next);
        }
      }
      running.clear();
      for (const [key, tracked] of next) {
        tracked.process.cpuMicros = Math.max(0, tracked.readCpuMicros - tracked.absorbedCpuMicros);
        running.set(key, tracked);
      }
      rebuild();
    },
  };
};
