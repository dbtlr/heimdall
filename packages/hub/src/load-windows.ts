import { SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { VitalsSample } from '@heimdall/schema';

import type { ConditionLimits } from './condition-limits.ts';

export type Kind = 'high_cpu' | 'high_memory';
export type Level = 'note' | 'warning';
export type Reading = {
  t: Date;
  cpu_busy_percent: number;
  memory_total_bytes: string;
  memory_used_bytes: string;
  memory_pressure: VitalsSample['memory']['pressure'] | null;
  collector_platform: string | null;
  uptime_seconds: number;
};
type Interval = { from: number; to: number; busy: boolean };

// Only measured intervals count. Missing intervals remain unknown, so sleep
// or a failed pressure probe cannot supply evidence of recovery.
export class Window {
  private readonly intervals: Interval[] = [];
  private head = 0;
  busy = 0;
  known = 0;

  readonly minutes: number;

  constructor(minutes: number) {
    this.minutes = minutes;
  }

  add(interval: Interval | undefined, at: number) {
    if (interval !== undefined) {
      this.intervals.push(interval);
      this.known += interval.to - interval.from;
      if (interval.busy) {
        this.busy += interval.to - interval.from;
      }
    }
    const since = at - this.minutes * 60_000;
    let first = this.intervals[this.head];
    while (first !== undefined && first.from < since) {
      const removed = Math.min(first.to, since) - first.from;
      this.known -= removed;
      if (first.busy) {
        this.busy -= removed;
      }
      if (first.to > since) {
        first.from = since;
        break;
      }
      this.head += 1;
      first = this.intervals[this.head];
    }
  }

  possibleBusy() {
    return this.busy + Math.max(0, this.minutes * 60_000 - this.known);
  }
}

const memoryBusy = (row: Reading, percent: number): boolean | undefined => {
  const total = Number(row.memory_total_bytes);
  if (total === 0) {
    return undefined;
  }
  if ((100 * Number(row.memory_used_bytes)) / total <= percent) {
    return false;
  }
  if (row.collector_platform === 'linux') {
    return true;
  }
  if (row.collector_platform !== 'darwin' || row.memory_pressure == null) {
    return undefined;
  }
  return row.memory_pressure !== 'normal';
};

export const rulesFor = (limits: Omit<ConditionLimits, 'systems'>) =>
  [
    {
      duration: limits.cpu.warningMinutes * 60_000,
      kind: 'high_cpu',
      level: 'warning',
      percent: limits.cpu.percent,
      window: new Window(limits.cpu.warningWindowMinutes),
    },
    {
      duration: limits.cpu.noteMinutes * 60_000,
      kind: 'high_cpu',
      level: 'note',
      percent: limits.cpu.percent,
      window: new Window(limits.cpu.noteWindowMinutes),
    },
    {
      duration: limits.memory.warningMinutes * 60_000,
      kind: 'high_memory',
      level: 'warning',
      percent: limits.memory.percent,
      window: new Window(limits.memory.warningWindowMinutes),
    },
  ] satisfies { kind: Kind; level: Level; percent: number; duration: number; window: Window }[];

export const feedRules = (
  rules: ReturnType<typeof rulesFor>,
  row: Reading,
  previous: Reading | undefined,
) => {
  const at = row.t.getTime();
  const elapsed = previous === undefined ? 0 : at - previous.t.getTime();
  const awake = previous === undefined ? 0 : (row.uptime_seconds - previous.uptime_seconds) * 1000;
  const duration =
    elapsed > 0 && elapsed <= 2 * SAMPLE_INTERVAL_MS && awake > 0
      ? Math.min(SAMPLE_INTERVAL_MS, elapsed, awake)
      : 0;
  let memoryKnown = false;
  for (const rule of rules) {
    const busy =
      rule.kind === 'high_cpu'
        ? row.cpu_busy_percent > rule.percent
        : memoryBusy(row, rule.percent);
    if (rule.kind === 'high_memory') {
      memoryKnown = duration > 0 && busy !== undefined;
    }
    rule.window.add(
      duration === 0 || busy === undefined ? undefined : { busy, from: at - duration, to: at },
      at,
    );
  }
  return {
    cpuKnown: duration > 0,
    memoryKnown,
  };
};

export const selectedRule = (
  rules: ReturnType<typeof rulesFor>,
  kind: Kind,
  current: Level | undefined,
  old = false,
) =>
  chooseWindowRule(
    rules.filter((rule) => rule.kind === kind),
    current,
    old,
  );

// Unknown time can retain a held level, but only measured busy time can raise it.
export const chooseWindowRule = <Rule extends { level: Level; duration: number; window: Window }>(
  candidates: Rule[],
  current: Level | undefined,
  old = false,
) => {
  const ranks = { note: 0, warning: 1 };
  const rank = current === undefined ? -1 : ranks[current];
  return candidates.find((rule) => {
    if (rule.window.busy >= rule.duration) {
      return true;
    }
    const candidateRank = ranks[rule.level];
    return (
      candidateRank <= rank &&
      ((old && rule.level === current) || rule.window.possibleBusy() >= rule.duration)
    );
  });
};

export const reasonFor = (rule: ReturnType<typeof rulesFor>[number], row: Reading) => {
  const name = rule.kind === 'high_cpu' ? 'CPU' : 'Memory';
  const pressure =
    rule.kind === 'high_memory' && row.collector_platform === 'darwin'
      ? ' with memory pressure'
      : '';
  if (rule.window.busy < rule.duration) {
    const unknownMinutes = Math.max(0, rule.window.minutes - rule.window.known / 60_000);
    return `${name} load remains uncertain: ${String(Math.round(unknownMinutes * 10) / 10)} minutes are unknown in the ${String(rule.window.minutes)} minutes ending ${row.t.toISOString()}; the ${rule.level} limit could still be met.`;
  }
  return `${name} above ${String(rule.percent)}%${pressure} for ${String(Math.round((rule.window.busy / 60_000) * 10) / 10)} minutes in the ${String(rule.window.minutes)} minutes ending ${row.t.toISOString()}.`;
};
