import { parseProcessSubject, processSubject, SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { ProcessObservation } from '@heimdall/schema';

import type { ConditionLimits } from './condition-limits.ts';
import { chooseWindowRule, Window } from './load-windows.ts';
import type { Level } from './load-windows.ts';

export type ProcessReading = {
  t: Date;
  uptime_seconds: number;
  processes: ProcessObservation | null;
};

type Identity = NonNullable<ReturnType<typeof parseProcessSubject>>;
export type ProcessWindow = {
  identity: Identity;
  endedAt: Date | undefined;
  known: boolean;
  rules: ReturnType<typeof rulesFor>;
};

const rulesFor = (limits: ConditionLimits['process']) =>
  [
    {
      duration: limits.warningMinutes * 60_000,
      level: 'warning',
      window: new Window(limits.warningWindowMinutes),
    },
    {
      duration: limits.noteMinutes * 60_000,
      level: 'note',
      window: new Window(limits.noteWindowMinutes),
    },
  ] satisfies { duration: number; level: Level; window: Window }[];

// A process lifetime is independent of other instances of the same executable.
export const addProcessWindow = (
  states: Map<string, ProcessWindow>,
  subject: string,
  limits: ConditionLimits['process'],
) => {
  if (!states.has(subject)) {
    const identity = parseProcessSubject(subject);
    if (identity !== undefined) {
      states.set(subject, { endedAt: undefined, identity, known: false, rules: rulesFor(limits) });
    }
  }
};

// A complete census proves absence. Top-N omission alone only bounds CPU when
// that PID's interval was readable and the omitted ceiling is below the limit.
export const feedProcessWindows = (
  states: Map<string, ProcessWindow>,
  row: ProcessReading,
  previous: ProcessReading | undefined,
  limits: ConditionLimits['process'],
) => {
  const observation = row.processes;
  const top = new Map(observation?.top.map((entry) => [entry.pid, entry]));
  for (const entry of observation?.top ?? []) {
    addProcessWindow(
      states,
      processSubject({ ...entry, bootId: observation?.bootId ?? '' }),
      limits,
    );
  }
  const at = row.t.getTime();
  const elapsed = previous === undefined ? 0 : at - previous.t.getTime();
  const awake = previous === undefined ? 0 : (row.uptime_seconds - previous.uptime_seconds) * 1000;
  const duration =
    observation !== null && elapsed > 0 && elapsed <= SAMPLE_INTERVAL_MS * 2 && awake > 0
      ? Math.min(SAMPLE_INTERVAL_MS, elapsed, awake, observation.intervalMs)
      : 0;
  const census = observation?.census;
  const present = new Set(census?.kind === 'complete' ? census.presentPids : []);
  const unknown = new Set(census?.kind === 'complete' ? census.unknownPids : []);
  for (const state of states.values()) {
    const { identity } = state;
    const entry = top.get(identity.pid);
    const replaced =
      observation !== null &&
      (observation.bootId !== identity.bootId ||
        (entry !== undefined && (entry.start !== identity.start || entry.name !== identity.name)));
    const confirmedExit = replaced || (census?.kind === 'complete' && !present.has(identity.pid));
    if (confirmedExit) {
      state.endedAt = row.t;
    }
    let busy: boolean | undefined;
    if (state.endedAt === undefined && duration > 0) {
      if (entry !== undefined) {
        busy = entry.cpuCores > limits.cores;
      } else if (
        census?.kind === 'complete' &&
        !unknown.has(identity.pid) &&
        census.remainderMaxCores <= limits.cores
      ) {
        busy = false;
      }
    }
    state.known = confirmedExit || busy !== undefined;
    for (const rule of state.rules) {
      rule.window.add(busy === undefined ? undefined : { busy, from: at - duration, to: at }, at);
    }
  }
};

export const selectProcessRule = (state: ProcessWindow, held: Level | undefined, old = false) =>
  state.endedAt === undefined ? chooseWindowRule(state.rules, held, old) : undefined;

export const processReason = (
  state: ProcessWindow,
  rule: ProcessWindow['rules'][number],
  row: ProcessReading,
  cores: number,
) => {
  const process = `${state.identity.name} (PID ${String(state.identity.pid)})`;
  if (rule.window.busy < rule.duration) {
    const unknown = Math.max(0, rule.window.minutes - rule.window.known / 60_000);
    return `${process} CPU remains uncertain: ${String(Math.round(unknown * 10) / 10)} minutes are unknown in the ${String(rule.window.minutes)} minutes ending ${row.t.toISOString()}; the ${rule.level} limit could still be met.`;
  }
  return `${process} above ${String(cores)} core for ${String(Math.round(rule.window.busy / 6000) / 10)} minutes in the ${String(rule.window.minutes)} minutes ending ${row.t.toISOString()}.`;
};
