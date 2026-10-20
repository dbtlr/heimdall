import type { ConditionKind } from '@heimdall/schema';
import type { SQL } from 'bun';

import { recordClosedOccurrence } from './conditions.ts';
import type { Level } from './load-windows.ts';

export type SampledEpisode = {
  kind: ConditionKind;
  subject: string;
  from: Date;
  steps: [{ level: Level; reason: string }, ...{ level: Level; reason: string }[]];
};
type Span = { kind: ConditionKind; subject: string; sample_from: Date; sample_until: Date };
const keyOf = ({ kind, subject }: { kind: ConditionKind; subject: string }) =>
  JSON.stringify([kind, subject]);

// A sampled span identifies an occurrence even when late readings move its
// boundaries. The Condition ID, including its subject, owns that span.
export const trackEpisodeSample = (
  tx: SQL,
  {
    system,
    kind,
    subject,
    at,
    terminal = false,
  }: {
    system: string;
    kind: ConditionKind;
    subject: string;
    at: Date;
    terminal?: boolean;
  },
) => tx`
  INSERT INTO load_episode_samples (condition, sample_from, sample_until)
  SELECT id, ${at}, ${at} FROM conditions
  WHERE system = ${system} AND kind = ${kind} AND subject = ${subject} AND cleared_at IS NULL
  ON CONFLICT (condition) DO UPDATE SET
    sample_from = LEAST(load_episode_samples.sample_from, excluded.sample_from),
    sample_until = CASE WHEN ${terminal} THEN excluded.sample_until
      ELSE GREATEST(load_episode_samples.sample_until, excluded.sample_until) END
`;

// Recovered historical episodes must not duplicate a recorded span or mutate
// a later current occurrence. Unfinished episodes keep a durable replay bound.
export const recordSampledEpisodes = async (
  tx: SQL,
  {
    system,
    kinds,
    from,
    through,
    now,
    completed,
    pending,
  }: {
    system: string;
    kinds: ConditionKind[];
    from: Date;
    through: Date;
    now: Date;
    completed: (SampledEpisode & { until: Date })[];
    pending: SampledEpisode[];
  },
) => {
  const inserted: Span[] = [];
  let pendingFrom: Date | undefined;
  if (completed.length === 0 && pending.length === 0) {
    return { inserted, pendingFrom };
  }
  const spans: Span[] = await tx`
    SELECT c.kind, c.subject, e.sample_from, e.sample_until
    FROM load_episode_samples e JOIN conditions c ON c.id = e.condition
    WHERE c.system = ${system} AND c.kind IN ${tx(kinds)}
      AND e.sample_until >= ${from} AND e.sample_from <= ${through}
    ORDER BY e.sample_from
  `;
  const byIdentity = new Map<string, Span[]>();
  for (const span of spans) {
    const key = keyOf(span);
    const held = byIdentity.get(key) ?? [];
    held.push(span);
    byIdentity.set(key, held);
  }
  const positions = new Map<string, number>();
  const overlaps = (episode: SampledEpisode, until: Date) => {
    const key = keyOf(episode);
    const candidates = byIdentity.get(key) ?? [];
    let position = positions.get(key) ?? 0;
    let span = candidates[position];
    while (span !== undefined && span.sample_until < episode.from) {
      position += 1;
      span = candidates[position];
    }
    positions.set(key, position);
    return span !== undefined && span.sample_from <= until;
  };
  for (const episode of completed) {
    if (overlaps(episode, episode.until)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- the System lock orders historical occurrences.
    const condition = await recordClosedOccurrence(tx, { ...episode, now, system });
    // oxlint-disable-next-line no-await-in-loop -- span and occurrence commit together.
    await tx`
      INSERT INTO load_episode_samples (condition, sample_from, sample_until)
      VALUES (${condition}, ${episode.from}, ${episode.until})
    `;
    inserted.push({
      kind: episode.kind,
      sample_from: episode.from,
      sample_until: episode.until,
      subject: episode.subject,
    });
  }
  for (const episode of pending) {
    if (!overlaps(episode, through) && (pendingFrom === undefined || episode.from < pendingFrom)) {
      pendingFrom = episode.from;
    }
  }
  return { inserted, pendingFrom };
};
