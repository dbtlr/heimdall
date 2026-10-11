import { HARNESS_NAMES, HARNESSES } from '../harnesses.ts';
import type { Harness } from '../harnesses.ts';
import type { ProcessEntry } from './table.ts';

// A Harness root process, and the CPU time and resident memory of it and its
// descendants.
export type HarnessRoot = {
  cpuMicros: number;
  entry: ProcessEntry;
  harness: Harness;
  rssBytes: number;
};

const harnessOf = (name: string): Harness | undefined =>
  HARNESS_NAMES.find((harness) => HARNESSES[harness].process.names.includes(name));

// The Harness root processes in a process table, in the order of the Harness
// list, then pid. A root is a Harness process whose parent is not a process of
// the same Harness: a helper that Claude Code starts under itself belongs to
// its tree, while a Claude Code that Codex starts, directly or through a shell,
// is a root of its own, as is any under an SDK host that is not a Harness. A
// process whose parent is missing from the table is a root.
//
// A root's totals cover its descendants except the trees of other roots under
// it, which are counted once, in their own root. One pass over the table:
// the children of every process are indexed once, and the Harness of every
// process is read once.
export const findHarnessRoots = (table: readonly ProcessEntry[]): HarnessRoot[] => {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const harnesses = new Map(table.map((entry) => [entry.pid, harnessOf(entry.name)]));
  const children = Map.groupBy(table, (entry) => entry.ppid);
  const isRoot = (entry: ProcessEntry, harness: Harness) => {
    const parent = byPid.get(entry.ppid);
    return parent === undefined || harnesses.get(parent.pid) !== harness;
  };

  const totalsOf = (root: ProcessEntry) => {
    let cpuMicros = 0;
    let rssBytes = 0;
    const visited = new Set<number>();
    const pending = [root];
    for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
      if (visited.has(entry.pid)) {
        continue;
      }
      visited.add(entry.pid);
      cpuMicros += entry.cpuMicros;
      rssBytes += entry.rssBytes;
      for (const child of children.get(entry.pid) ?? []) {
        const childHarness = harnesses.get(child.pid);
        // Another root's tree is that root's to count.
        if (childHarness === undefined || !isRoot(child, childHarness)) {
          pending.push(child);
        }
      }
    }
    return { cpuMicros, rssBytes };
  };

  return table
    .flatMap((entry) => {
      const harness = harnesses.get(entry.pid);
      return harness !== undefined && isRoot(entry, harness)
        ? [{ ...totalsOf(entry), entry, harness }]
        : [];
    })
    .toSorted(
      (a, b) =>
        HARNESS_NAMES.indexOf(a.harness) - HARNESS_NAMES.indexOf(b.harness) ||
        a.entry.pid - b.entry.pid,
    );
};
