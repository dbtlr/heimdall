import { MAX_PROCESS_CENSUS, MAX_TOP_PROCESSES, SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { ProcessObservation } from '@heimdall/schema';

import { memoryProcessNames, processNameKey } from './names.ts';
import type { ProcessName, ProcessNameStore } from './names.ts';
import type { ProcessEntry } from './table.ts';

type Reading = {
  bootId: string;
  entries: readonly ProcessEntry[];
  presentPids: readonly number[];
  at: number;
  monotonicMs: number;
  uptimeSeconds: number;
  nameOf?: (pid: number) => Promise<string | null>;
};

const ownCpu = (entry: ProcessEntry) => entry.cpuMicros - entry.reapedCpuMicros;
const validName = (name: string) => name.length > 0 && name.length <= 1024;
const startOf = (entry: ProcessEntry) => {
  if (entry.observationStart !== undefined) {
    return entry.observationStart;
  }
  return entry.kernelStart === null ? null : String(entry.kernelStart);
};

// Keeps one table baseline. Unmeasured processes remain explicitly unknown;
// a complete PID census can still prove that a formerly observed process exited.
export const createProcessObserver = ({
  names = memoryProcessNames(),
}: { names?: ProcessNameStore } = {}) => {
  let previous: Reading | undefined;
  const resolved = new Map(names.list().map((name) => [processNameKey(name), name]));
  return {
    observe: async (reading: Reading): Promise<ProcessObservation> => {
      const before = previous;
      previous = reading;
      const identityOf = (entry: { pid: number; start: string }) =>
        processNameKey({ bootId: reading.bootId, ...entry });
      const presentPids = [...new Set(reading.presentPids)].toSorted((a, b) => a - b);
      const present = new Set(presentPids);
      const live = new Map(
        reading.entries.flatMap((entry) => {
          const start = startOf(entry);
          return start === null
            ? []
            : [[entry.pid, identityOf({ pid: entry.pid, start })] satisfies [number, string]];
        }),
      );
      for (const [identity, name] of resolved) {
        if (
          name.bootId !== reading.bootId ||
          !present.has(name.pid) ||
          (live.has(name.pid) && live.get(name.pid) !== identity)
        ) {
          names.forget(name);
          resolved.delete(identity);
        }
      }
      const elapsed = before === undefined ? 0 : reading.monotonicMs - before.monotonicMs;
      const wall = before === undefined ? 0 : reading.at - before.at;
      const awake =
        before === undefined ? 0 : (reading.uptimeSeconds - before.uptimeSeconds) * 1000;
      const intervalMs =
        before?.bootId === reading.bootId &&
        elapsed > 0 &&
        elapsed <= 2 * SAMPLE_INTERVAL_MS &&
        wall > 0 &&
        wall <= 2 * SAMPLE_INTERVAL_MS &&
        awake > 0
          ? Math.min(SAMPLE_INTERVAL_MS, wall, awake, elapsed)
          : 0;
      const held = new Map(before?.entries.map((entry) => [entry.pid, entry]));
      const unknown = new Set(presentPids);
      const measured: ProcessObservation['top'] = [];
      for (const entry of reading.entries) {
        const previousEntry = held.get(entry.pid);
        const start = startOf(entry);
        const delta = previousEntry === undefined ? -1 : ownCpu(entry) - ownCpu(previousEntry);
        if (
          intervalMs === 0 ||
          previousEntry === undefined ||
          start === null ||
          start !== startOf(previousEntry) ||
          delta < 0
        ) {
          continue;
        }
        unknown.delete(entry.pid);
        measured.push({
          cpuCores: delta / (elapsed * 1000),
          name: entry.name,
          pid: entry.pid,
          rssBytes: entry.rssBytes,
          start,
        });
      }
      const ordered = measured.toSorted((a, b) => b.cpuCores - a.cpuCores || a.pid - b.pid);
      const candidates = await Promise.all(
        ordered.slice(0, MAX_TOP_PROCESSES).map(async (entry) => {
          const identity = identityOf(entry);
          const executable = (await reading.nameOf?.(entry.pid)) ?? null;
          const heldName = resolved.get(identity);
          const changed =
            heldName?.kind === 'confirmed' &&
            executable !== null &&
            heldName.executable !== executable;
          const name = changed ? executable : (heldName?.label ?? executable ?? entry.name);
          if (!validName(name) || (executable !== null && !validName(executable))) {
            unknown.add(entry.pid);
            return [];
          }
          const lifetime = { bootId: reading.bootId, pid: entry.pid, start: entry.start };
          const next: ProcessName =
            executable === null
              ? (heldName ?? { ...lifetime, kind: 'fallback', label: name })
              : { ...lifetime, executable, kind: 'confirmed', label: name };
          const unchanged =
            heldName !== undefined &&
            heldName.label === next.label &&
            heldName.kind === next.kind &&
            (heldName.kind === 'fallback' ||
              (next.kind === 'confirmed' && heldName.executable === next.executable));
          if (!unchanged) {
            names.save(next);
          }
          resolved.set(identity, next);
          if (changed) {
            unknown.add(entry.pid);
            return [];
          }
          return [{ ...entry, name }];
        }),
      );
      const top = candidates.flat();
      const unknownPids = [...unknown].toSorted((a, b) => a - b);
      return {
        bootId: reading.bootId,
        census:
          presentPids.length > MAX_PROCESS_CENSUS || unknownPids.length > MAX_PROCESS_CENSUS
            ? { kind: 'partial' }
            : {
                kind: 'complete',
                presentPids,
                remainderMaxCores: ordered[MAX_TOP_PROCESSES]?.cpuCores ?? 0,
                unknownPids,
              },
        intervalMs,
        top,
      };
    },
    reset: () => {
      previous = undefined;
    },
  };
};
