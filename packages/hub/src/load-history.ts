import type { SQL } from 'bun';

import type { ConditionLimits } from './condition-limits.ts';
import { recordClosedOccurrence } from './conditions.ts';
import { feedRules, reasonFor, rulesFor, selectedRule } from './load-windows.ts';
import type { Kind, Level, Reading } from './load-windows.ts';

type Step = { level: Level; reason: string };
type Episode = {
  from: Date;
  level: Level;
  steps: [Step, ...Step[]];
};
type Recovered = Episode & { kind: Kind; until: Date };
type Span = { kind: Kind; sample_from: Date; sample_until: Date };

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
  const episodes = replayEpisodes(rows, limits, through);
  const inserted: Span[] = [];
  let pendingFrom: Date | undefined;
  const first = rows[0];
  if ((episodes.recovered.length === 0 && episodes.open.size === 0) || first === undefined) {
    return { inserted, pendingFrom };
  }
  const spans: Span[] = await tx`
    SELECT c.kind, e.sample_from, e.sample_until
    FROM load_episode_samples e JOIN conditions c ON c.id = e.condition
    WHERE c.system = ${system} AND c.kind IN ${tx(KINDS)}
      AND e.sample_until >= ${first.t} AND e.sample_from <= ${through}
    ORDER BY e.sample_from
  `;
  const existing = new Map(KINDS.map((kind) => [kind, spans.filter((span) => span.kind === kind)]));
  const positions = new Map<Kind, number>();
  // Each kind's recovered episodes precede its remaining open episode, so
  // overlap checks advance once through the recorded sample spans.
  const overlaps = (kind: Kind, from: Date, until: Date) => {
    const candidates = existing.get(kind) ?? [];
    let position = positions.get(kind) ?? 0;
    let span = candidates[position];
    while (span !== undefined && span.sample_until < from) {
      position += 1;
      span = candidates[position];
    }
    positions.set(kind, position);
    return span !== undefined && span.sample_from <= until;
  };
  for (const episode of episodes.recovered) {
    if (overlaps(episode.kind, episode.from, episode.until)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- the System lock serializes occurrence insertion.
    const condition = await recordClosedOccurrence(tx, {
      kind: episode.kind,
      now,
      steps: episode.steps,
      subject: '',
      system,
    });
    // oxlint-disable-next-line no-await-in-loop -- span and Timeline must commit together.
    await tx`
      INSERT INTO load_episode_samples (condition, sample_from, sample_until)
      VALUES (${condition}, ${episode.from}, ${episode.until})
    `;
    inserted.push({ kind: episode.kind, sample_from: episode.from, sample_until: episode.until });
  }
  // Keep unrecorded episodes in the next replay even after their measured
  // busy time has left the rolling window and only unknown time retains them.
  for (const [kind, episode] of episodes.open) {
    if (
      !overlaps(kind, episode.from, through) &&
      (pendingFrom === undefined || episode.from < pendingFrom)
    ) {
      pendingFrom = episode.from;
    }
  }
  return { inserted, pendingFrom };
};
