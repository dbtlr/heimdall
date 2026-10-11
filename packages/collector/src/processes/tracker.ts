import { MAX_HARNESS_PROCESSES } from '@heimdall/schema';
import type { HarnessProcess, HarnessProcessesSection } from '@heimdall/schema';

import { findHarnessRoots } from './roots.ts';
import type { ProcessReader } from './table.ts';

// How far a process's start time may differ between two reads and still be the
// same process. A pid reused by a new process starts later than this.
const SAME_PROCESS_MS = 5000;

type Running = Omit<HarnessProcess, 'endedAt'>;
type Ended = HarnessProcess & { endedAt: number };

const keyOf = (process: { harness: string; pid: number }) =>
  `${process.harness}:${String(process.pid)}`;

// Watches the Harness root processes tick by tick and keeps the section that
// reports them: the ones running now, and the ones that ended, until the Hub
// acknowledges them.
//
// A tick reads the process table once (`reader.table`) and the working
// directory of each root. A process in the previous tick's table and not in
// this one ended at this tick's time, which is when the Collector noticed, not
// when the process exited. A process the Collector was not running to see end is
// the Hub's to close (see the spec). A start time seen again within a few
// seconds is the same process; a pid whose start moved further is a new process.
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
  const running = new Map<string, Running>();
  let ended: Ended[] = [];
  let latest: HarnessProcessesSection | undefined;

  const rebuild = () => {
    latest = { processes: [...ended, ...running.values()] };
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
      const next = new Map<string, Running>();
      for (const { cwd, root } of seen) {
        const { entry, harness } = root;
        const key = keyOf({ harness, pid: entry.pid });
        let before = running.get(key);
        if (
          before !== undefined &&
          Math.abs(before.startedAt - entry.startedAt) > SAME_PROCESS_MS
        ) {
          // The pid now belongs to another process.
          ended.push({ ...before, endedAt: at });
          before = undefined;
        }
        next.set(key, {
          cpuMicros: root.cpuMicros,
          cwd: cwd ?? before?.cwd ?? null,
          harness,
          lastSeenAt: at,
          peakRssBytes: Math.max(before?.peakRssBytes ?? 0, root.rssBytes),
          pid: entry.pid,
          rssBytes: root.rssBytes,
          startedAt: before?.startedAt ?? entry.startedAt,
        });
      }
      for (const [key, process] of running) {
        const kept = next.get(key);
        if (kept === undefined) {
          ended.push({ ...process, endedAt: at });
        }
      }
      running.clear();
      for (const [key, process] of next) {
        running.set(key, process);
      }
      ended = ended.slice(-MAX_HARNESS_PROCESSES);
      rebuild();
    },
  };
};
