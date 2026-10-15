import { MAX_PROCESS_CENSUS, MAX_TOP_PROCESSES, SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { ProcessObservation } from '@heimdall/schema';

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

// Keeps one table baseline. Unmeasured processes remain explicitly unknown;
// a complete PID census can still prove that a formerly observed process exited.
export const createProcessObserver = () => {
  let previous: Reading | undefined;
  let resolved = new Map<string, string>();
  return {
    observe: async (reading: Reading): Promise<ProcessObservation> => {
      const before = previous;
      previous = reading;
      const identityOf = (entry: { pid: number; start: string }) =>
        `${reading.bootId}:${String(entry.pid)}:${entry.start}`;
      const live = new Set(
        reading.entries.map((entry) =>
          identityOf({ pid: entry.pid, start: String(entry.kernelStart) }),
        ),
      );
      resolved = new Map([...resolved].filter(([identity]) => live.has(identity)));
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
      const presentPids = [...new Set(reading.presentPids)].toSorted((a, b) => a - b);
      const unknown = new Set(presentPids);
      const measured: ProcessObservation['top'] = [];
      for (const entry of reading.entries) {
        const previousEntry = held.get(entry.pid);
        const delta = previousEntry === undefined ? -1 : ownCpu(entry) - ownCpu(previousEntry);
        if (
          intervalMs === 0 ||
          previousEntry === undefined ||
          entry.kernelStart === null ||
          entry.kernelStart !== previousEntry.kernelStart ||
          entry.name !== previousEntry.name ||
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
          start: String(entry.kernelStart),
        });
      }
      const ordered = measured.toSorted((a, b) => b.cpuCores - a.cpuCores || a.pid - b.pid);
      const candidates = await Promise.all(
        ordered.slice(0, MAX_TOP_PROCESSES).map(async (entry) => {
          const identity = identityOf(entry);
          const name = (await reading.nameOf?.(entry.pid)) ?? entry.name;
          const oldName = resolved.get(identity);
          resolved.set(identity, name);
          if (oldName !== undefined && oldName !== name) {
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
      resolved.clear();
    },
  };
};
