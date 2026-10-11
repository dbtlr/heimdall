import { MAX_HARNESS_PROCESSES, SAME_HARNESS_PROCESS_MS } from '@heimdall/schema';
import type { HarnessProcess, HarnessProcessesSection } from '@heimdall/schema';

import { findHarnessRoots } from './roots.ts';
import type { ProcessEntry, ProcessReader } from './table.ts';

type Running = Omit<HarnessProcess, 'endedAt'>;
type Ended = HarnessProcess & { endedAt: number };

// How many ticks, counting the one that finds a nested root gone, its CPU
// time may take to reach the enclosing root's reaped children's time. Time
// that has not arrived by then went elsewhere, such as to init.
const ABSORB_TICKS = 2;

// The CPU time of a nested root that ended, which may still move into the
// enclosing root's reading, and the ticks left for it to.
type Pending = { cpuMicros: number; ticksLeft: number };

// A running process as the tracker holds it: the kernel's start it was first
// seen with, its tree's CPU time and reaped children's time as read, the CPU
// time of ended nested roots that moved into that reading or may yet, and the
// root whose tree it sits in.
type Tracked = {
  absorbedCpuMicros: number;
  enclosing: string | undefined;
  kernelStart: number | null;
  pending: Pending[];
  process: Running;
  readCpuMicros: number;
  reapedCpuMicros: number;
};

// Takes from `pending`, oldest first, as much as the reaped children's time
// grew since the last tick, and counts each pending one's tick. Returns the
// CPU time taken and what is still pending.
const absorb = (pending: readonly Pending[], grew: number) => {
  let left = Math.max(0, grew);
  let taken = 0;
  const still: Pending[] = [];
  for (const { cpuMicros, ticksLeft } of pending) {
    const take = Math.min(left, cpuMicros);
    left -= take;
    taken += take;
    if (cpuMicros > take && ticksLeft > 1) {
      still.push({ cpuMicros: cpuMicros - take, ticksLeft: ticksLeft - 1 });
    }
  }
  return { still, taken };
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
// and is waited for inside the enclosing root's tree, its time moves into the
// enclosing root's reaped children's time, so the enclosing root subtracts the
// nested root's last reading, but never more than its reaped children's time
// grew from the tick before the end through the next ABSORB_TICKS ticks. A
// nested root that an outside process waited for, such as init, so takes
// nothing, and where reaped time is not counted (macOS) nothing is ever taken.
// A nested root's CPU used between its last tick and its end still counts in
// the enclosing root. A root's reported CPU time never falls: a reading below
// the last one reported, as when a descendant leaves the tree, reports the
// last one again.
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

  // Ends a process at `at`. Its CPU time may move into the enclosing root's
  // reading, so the enclosing root holds it as pending.
  const end = (tracked: Tracked, at: number, next: Map<string, Tracked>) => {
    ended.push({ ...tracked.process, endedAt: at });
    const enclosing = tracked.enclosing === undefined ? undefined : next.get(tracked.enclosing);
    enclosing?.pending.push({ cpuMicros: tracked.readCpuMicros, ticksLeft: ABSORB_TICKS });
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
      const reapedNow = new Map<string, number>();
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
          pending: kept?.pending ?? [],
          process: {
            cpuMicros: before?.cpuMicros ?? 0,
            cwd: cwd ?? before?.cwd ?? null,
            harness,
            lastSeenAt: at,
            peakRssBytes: Math.max(before?.peakRssBytes ?? 0, root.rssBytes),
            pid: entry.pid,
            rssBytes: root.rssBytes,
            startedAt: before?.startedAt ?? entry.startedAt,
          },
          readCpuMicros: root.cpuMicros,
          // Read as of the last tick until this one's growth is taken below.
          reapedCpuMicros: kept?.reapedCpuMicros ?? root.reapedCpuMicros,
        });
        reapedNow.set(key, root.reapedCpuMicros);
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
        const reaped = reapedNow.get(key) ?? tracked.reapedCpuMicros;
        const { still, taken } = absorb(tracked.pending, reaped - tracked.reapedCpuMicros);
        tracked.absorbedCpuMicros += taken;
        tracked.pending = still;
        tracked.reapedCpuMicros = reaped;
        tracked.process.cpuMicros = Math.max(
          tracked.process.cpuMicros,
          tracked.readCpuMicros - tracked.absorbedCpuMicros,
        );
        running.set(key, tracked);
      }
      rebuild();
    },
  };
};
