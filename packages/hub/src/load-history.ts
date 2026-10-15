import type { SQL } from 'bun';

import type { ConditionLimits } from './condition-limits.ts';
import { feedRules, reasonFor, rulesFor, selectedRule } from './load-windows.ts';
import type { Kind, Level, Reading } from './load-windows.ts';
import { recordSampledEpisodes } from './sampled-history.ts';

type Step = { level: Level; reason: string };
type Episode = {
  from: Date;
  level: Level;
  steps: [Step, ...Step[]];
};
type Recovered = Episode & { kind: Kind; until: Date };

const KINDS: Kind[] = ['high_cpu', 'high_memory'];

// Historical recovery follows sampled evidence; wall-clock age must not turn
// an already completed episode into a new current problem.
const replayEpisodes = (
  rows: Reading[],
  limits: Omit<ConditionLimits, 'systems'>,
  through: Date,
) => {
  const rules = rulesFor(limits);
  const open = new Map<Kind, Episode>();
  const recovered: Recovered[] = [];
  let previous: Reading | undefined;
  for (const row of rows) {
    if (row.t > through) {
      break;
    }
    feedRules(rules, row, previous);
    previous = row;
    for (const kind of KINDS) {
      const held = open.get(kind);
      const selected = selectedRule(rules, kind, held?.level);
      if (selected === undefined) {
        if (held !== undefined) {
          recovered.push({ ...held, kind, until: row.t });
          open.delete(kind);
        }
      } else if (held === undefined) {
        const step = { level: selected.level, reason: reasonFor(selected, row) };
        open.set(kind, { from: row.t, level: selected.level, steps: [step] });
      } else if (selected.level !== held.level) {
        held.steps.push({ level: selected.level, reason: reasonFor(selected, row) });
        held.level = selected.level;
      }
    }
  }
  return { open, recovered };
};

// Sample spans identify previously recorded episodes even when new readings
// move their qualifying boundaries. Existing Timeline history stays intact.
export const recordHistoricalLoad = async (
  tx: SQL,
  {
    system,
    rows,
    limits,
    through,
    now,
  }: {
    system: string;
    rows: Reading[];
    limits: Omit<ConditionLimits, 'systems'>;
    through: Date;
    now: Date;
  },
) => {
  const first = rows[0];
  if (first === undefined) {
    return { inserted: [], pendingFrom: undefined };
  }
  const episodes = replayEpisodes(rows, limits, through);
  return recordSampledEpisodes(tx, {
    completed: episodes.recovered.map((episode) => ({ ...episode, subject: '' })),
    from: first.t,
    kinds: KINDS,
    now,
    pending: [...episodes.open].map(([kind, episode]) => ({
      from: episode.from,
      kind,
      steps: episode.steps,
      subject: '',
    })),
    system,
    through,
  });
};
