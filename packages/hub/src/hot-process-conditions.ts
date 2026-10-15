import { FUTURE_SAMPLE_TOLERANCE_MS, OLD_EVIDENCE_MS, SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { SQL } from 'bun';

import type { ConditionLimits } from './condition-limits.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import {
  addProcessWindow,
  feedProcessWindows,
  processReason,
  selectProcessRule,
} from './hot-process-windows.ts';
import type { ProcessReading, ProcessWindow } from './hot-process-windows.ts';
import type { Level } from './load-windows.ts';
import { recordSampledEpisodes, trackEpisodeSample } from './sampled-history.ts';
import type { SampledEpisode } from './sampled-history.ts';
import { storableJson } from './storable.ts';
import { pairedSystems, whenPaired } from './tokens.ts';

const KIND = 'hot_process';

// Drop completed lifetimes and windows whose busy evidence has fully expired.
const prune = (states: Map<string, ProcessWindow>, held: ReadonlyMap<string, unknown>) => {
  for (const [subject, state] of states) {
    if (
      !held.has(subject) &&
      (state.endedAt !== undefined || state.rules.every((rule) => rule.window.busy === 0))
    ) {
      states.delete(subject);
    }
  }
};

const replayHistory = (rows: ProcessReading[], limits: ConditionLimits['process']) => {
  const states = new Map<string, ProcessWindow>();
  const open = new Map<string, SampledEpisode & { level: Level }>();
  const completed: (SampledEpisode & { until: Date })[] = [];
  let previous: ProcessReading | undefined;
  for (const row of rows) {
    feedProcessWindows(states, row, previous, limits);
    previous = row;
    for (const [subject, state] of states) {
      const episode = open.get(subject);
      const selected = selectProcessRule(state, episode?.level);
      if (selected === undefined) {
        if (episode !== undefined) {
          completed.push({ ...episode, until: row.t });
          open.delete(subject);
        }
      } else if (episode === undefined) {
        open.set(subject, {
          from: row.t,
          kind: KIND,
          level: selected.level,
          steps: [
            { level: selected.level, reason: processReason(state, selected, row, limits.cores) },
          ],
          subject,
        });
      } else if (selected.level !== episode.level) {
        episode.steps.push({
          level: selected.level,
          reason: processReason(state, selected, row, limits.cores),
        });
        episode.level = selected.level;
      }
    }
    prune(states, open);
  }
  return { completed, pending: [...open.values()] };
};

const judgeSystem = (sql: SQL, system: string, clock: () => number, limits: ConditionLimits) =>
  sql.begin(async (tx) => {
    const paired = await whenPaired(tx, system);
    await tx`SELECT 1 FROM systems WHERE name = ${system} FOR UPDATE`;
    const now = clock();
    const held: { subject: string; level: Level; sample_from: Date | null }[] = await tx`
      SELECT c.subject, c.level, e.sample_from FROM conditions c
      LEFT JOIN load_episode_samples e ON e.condition = c.id
      WHERE c.system = ${system} AND c.kind = ${KIND} AND c.cleared_at IS NULL
    `;
    if (paired === undefined) {
      for (const { subject } of held) {
        // oxlint-disable-next-line no-await-in-loop -- transitions share the System lock.
        await clear(tx, { kind: KIND, now: new Date(now), subject, system });
      }
      return;
    }
    const selectedLimits = (limits.systems.get(system) ?? limits).process;
    const [cursor]: {
      through: Date;
      dirty_from: Date | null;
      pending_from: Date | null;
      limits: ConditionLimits['process'];
    }[] = await tx`
      SELECT through, dirty_from, pending_from, limits FROM hot_process_evaluations WHERE system = ${system}
    `;
    const [newest]: { t: Date }[] = await tx`
      SELECT t FROM vitals_samples WHERE system = ${system} AND t <= ${new Date(now + FUTURE_SAMPLE_TOLERANCE_MS)}
      ORDER BY t DESC LIMIT 1
    `;
    if (newest === undefined || (cursor !== undefined && newest.t < cursor.through)) {
      return;
    }
    if (
      cursor !== undefined &&
      newest.t.getTime() === cursor.through.getTime() &&
      cursor.dirty_from === null &&
      Object.entries(selectedLimits).every(
        ([key, value]) => Reflect.get(cursor.limits, key) === value,
      )
    ) {
      return;
    }
    const largestWindow =
      Math.max(selectedLimits.noteWindowMinutes, selectedLimits.warningWindowMinutes) * 60_000;
    const after =
      cursor === undefined || cursor.dirty_from !== null
        ? null
        : new Date(
            Math.min(
              cursor.through.getTime(),
              cursor.pending_from?.getTime() ?? cursor.through.getTime(),
            ) -
              largestWindow -
              SAMPLE_INTERVAL_MS,
          );
    const rows: ProcessReading[] = await tx`
      SELECT t, uptime_seconds, processes FROM vitals_samples
      WHERE system = ${system} AND (${after}::timestamptz IS NULL OR t >= ${after}) AND t <= ${newest.t}
      ORDER BY t
    `;
    const latest = rows.at(-1);
    const first = rows[0];
    if (latest === undefined || first === undefined) {
      return;
    }
    const old = now - latest.t.getTime() > OLD_EVIDENCE_MS;
    let pendingFrom = cursor?.pending_from ?? undefined;
    let inserted: { subject: string; sample_from: Date; sample_until: Date }[] = [];
    if (
      cursor?.dirty_from != null ||
      ((old || pendingFrom !== undefined) && (cursor === undefined || latest.t > cursor.through))
    ) {
      for (const { subject } of held) {
        // oxlint-disable-next-line no-await-in-loop -- replay must see each current occurrence's full span.
        await trackEpisodeSample(tx, { at: latest.t, kind: KIND, subject, system });
      }
      const episodes = replayHistory(rows, selectedLimits);
      const history = await recordSampledEpisodes(tx, {
        ...episodes,
        from: first.t,
        kinds: [KIND],
        now: new Date(now),
        system,
        through: latest.t,
      });
      inserted = history.inserted;
      pendingFrom = history.pendingFrom;
    }
    const covered = new Map<string, typeof inserted>();
    for (const span of inserted) {
      const spans = covered.get(span.subject) ?? [];
      spans.push(span);
      covered.set(span.subject, spans);
    }
    const positions = new Map<string, number>();
    const states = new Map<string, ProcessWindow>();
    const current = new Map(held.map(({ subject, level }) => [subject, level]));
    let previous: ProcessReading | undefined;
    for (const row of rows) {
      // Earlier generations in the replay must not end a lifetime that had
      // not appeared yet. Quiet windows still seed held, older lifetimes.
      for (const { subject, sample_from } of held) {
        if (row.t >= (sample_from ?? latest.t)) {
          addProcessWindow(states, subject, selectedLimits);
        }
      }
      feedProcessWindows(states, row, previous, selectedLimits);
      previous = row;
      if (row !== latest && ((cursor !== undefined && row.t <= cursor.through) || old)) {
        prune(states, current);
        continue;
      }
      for (const [subject, state] of states) {
        const level = current.get(subject);
        const spans = covered.get(subject) ?? [];
        let position = positions.get(subject) ?? 0;
        while (
          spans[position] !== undefined &&
          (spans[position]?.sample_until.getTime() ?? 0) < row.t.getTime()
        ) {
          position += 1;
        }
        positions.set(subject, position);
        const span = spans[position];
        if (level === undefined && span !== undefined && span.sample_from <= row.t) {
          continue;
        }
        if (old && level === undefined) {
          continue;
        }
        // A later host-only sample cannot make an old exit observation fresh.
        if (state.endedAt !== undefined && now - state.endedAt.getTime() > OLD_EVIDENCE_MS) {
          continue;
        }
        const rule = selectProcessRule(state, level, old);
        if (rule?.level === level && rule !== undefined && rule.window.busy < rule.duration) {
          continue;
        }
        if (rule === undefined) {
          if (level !== undefined) {
            // oxlint-disable-next-line no-await-in-loop -- terminal span and clearing commit together.
            await trackEpisodeSample(tx, {
              at: row.t,
              kind: KIND,
              subject,
              system,
              terminal: true,
            });
            // oxlint-disable-next-line no-await-in-loop -- transitions share the System lock.
            await clear(tx, { kind: KIND, now: new Date(now), subject, system });
            current.delete(subject);
          }
        } else {
          if (rule.level === level && row !== latest) {
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- level and cursor commit together.
          await raise(tx, {
            kind: KIND,
            level: rule.level,
            now: new Date(now),
            reason: processReason(state, rule, row, selectedLimits.cores),
            subject,
            system,
          });
          // oxlint-disable-next-line no-await-in-loop -- span and level share the transaction.
          await trackEpisodeSample(tx, { at: row.t, kind: KIND, subject, system });
          current.set(subject, rule.level);
        }
      }
      prune(states, current);
    }
    const coverage = Object.fromEntries(
      [...states].map(([subject, state]) => [subject, state.known]),
    );
    await tx`
      INSERT INTO hot_process_evaluations (system, through, pending_from, coverage, limits)
      VALUES (${system}, ${latest.t}, ${pendingFrom ?? null}, ${storableJson(coverage)}::text::jsonb, ${storableJson(selectedLimits)}::text::jsonb)
      ON CONFLICT (system) DO UPDATE SET through = GREATEST(hot_process_evaluations.through, excluded.through),
        dirty_from = NULL, pending_from = excluded.pending_from, coverage = excluded.coverage, limits = excluded.limits
    `;
  });

// Shares the Hub's measured-window and Timeline rules, with one subject per lifetime.
export const evaluateHotProcessConditions = async (
  sql: SQL,
  clock: () => number,
  limits: ConditionLimits,
) => {
  const paired = await pairedSystems(sql);
  const held: { system: string }[] = await sql`
    SELECT DISTINCT system FROM conditions WHERE kind = ${KIND} AND cleared_at IS NULL
  `;
  await evaluateEach(
    [...new Set([...paired, ...held.map(({ system }) => system)])].toSorted(),
    (system) => judgeSystem(sql, system, clock, limits),
  );
};
