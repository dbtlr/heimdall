import { FUTURE_SAMPLE_TOLERANCE_MS, OLD_EVIDENCE_MS, SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { SQL } from 'bun';

import type { ConditionLimits } from './condition-limits.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import { recordHistoricalLoad } from './load-history.ts';
import { feedRules, reasonFor, rulesFor, selectedRule } from './load-windows.ts';
import type { Kind, Level, Reading } from './load-windows.ts';
import { pairedSystems, whenPaired } from './tokens.ts';

const KINDS: Kind[] = ['high_cpu', 'high_memory'];

const trackSample = (
  tx: SQL,
  {
    system,
    kind,
    at,
    terminal = false,
  }: {
    system: string;
    kind: Kind;
    at: Date;
    terminal?: boolean;
  },
) => tx`
  INSERT INTO load_episode_samples (condition, sample_from, sample_until)
  SELECT id, ${at}, ${at} FROM conditions
  WHERE system = ${system} AND kind = ${kind} AND cleared_at IS NULL
  ON CONFLICT (condition) DO UPDATE SET
    sample_from = LEAST(load_episode_samples.sample_from, excluded.sample_from),
    sample_until = CASE WHEN ${terminal} THEN excluded.sample_until
      ELSE GREATEST(load_episode_samples.sample_until, excluded.sample_until) END
`;

const judgeSystem = (sql: SQL, system: string, clock: () => number, limits: ConditionLimits) =>
  sql.begin(async (tx) => {
    const paired = await whenPaired(tx, system);
    await tx`SELECT 1 FROM systems WHERE name = ${system} FOR UPDATE`;
    const now = clock();
    const held: { kind: Kind; level: Level }[] = await tx`
      SELECT kind, level FROM conditions
      WHERE system = ${system} AND kind IN ${tx(KINDS)} AND cleared_at IS NULL
    `;
    if (paired === undefined) {
      for (const kind of KINDS) {
        // oxlint-disable-next-line no-await-in-loop -- the System lock orders every transition.
        await clear(tx, { kind, now: new Date(now), subject: '', system });
      }
      return;
    }
    const selected = limits.systems.get(system) ?? limits;
    const rules = rulesFor(selected);
    const largestWindow = Math.max(...rules.map((rule) => rule.window.minutes)) * 60_000;
    const [cursor]: { through: Date; dirty_from: Date | null; pending_from: Date | null }[] =
      await tx`
      SELECT through, dirty_from, pending_from FROM load_evaluations WHERE system = ${system}
    `;
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
    const rows: Reading[] = await tx`
      SELECT t, cpu_busy_percent, memory_total_bytes, memory_used_bytes,
             memory_pressure, collector_platform, uptime_seconds
      FROM vitals_samples
      WHERE system = ${system} AND (${after}::timestamptz IS NULL OR t >= ${after})
        AND t <= ${new Date(now + FUTURE_SAMPLE_TOLERANCE_MS)}
      ORDER BY t
    `;
    const latest = rows.at(-1);
    if (latest === undefined || (cursor !== undefined && latest.t < cursor.through)) {
      return;
    }
    const old = now - latest.t.getTime() > OLD_EVIDENCE_MS;
    let pendingFrom = cursor?.pending_from ?? undefined;
    let backfilled: { kind: Kind; sample_from: Date; sample_until: Date }[] = [];
    if (
      cursor?.dirty_from != null ||
      ((old || pendingFrom !== undefined) && (cursor === undefined || latest.t > cursor.through))
    ) {
      // Historical replay must see the whole live span it could otherwise
      // duplicate. A subsequent live recovery trims it to the actual sample.
      for (const { kind } of held) {
        // oxlint-disable-next-line no-await-in-loop -- all spans share the System lock.
        await trackSample(tx, { at: latest.t, kind, system });
      }
      const history = await recordHistoricalLoad(tx, {
        limits: selected,
        now: new Date(now),
        rows,
        system,
        through: latest.t,
      });
      pendingFrom = history.pendingFrom;
      backfilled = history.inserted;
    }
    const spans = new Map(
      KINDS.map((kind) => [kind, backfilled.filter((span) => span.kind === kind)]),
    );
    const positions = new Map<Kind, number>();
    const current = new Map(held.map(({ kind, level }) => [kind, level]));
    let previous: Reading | undefined;
    let coverage = { cpuKnown: false, memoryKnown: false };
    for (const row of rows) {
      const at = row.t.getTime();
      coverage = feedRules(rules, row, previous);
      previous = row;
      // A durable cursor prevents a completed historical episode from being
      // raised again. The newest reading is still rejudged after limit changes.
      if (row !== latest && ((cursor !== undefined && at <= cursor.through.getTime()) || old)) {
        continue;
      }
      for (const kind of KINDS) {
        const level = current.get(kind);
        const covered = spans.get(kind) ?? [];
        let position = positions.get(kind) ?? 0;
        let span = covered[position];
        while (span !== undefined && span.sample_until < row.t) {
          position += 1;
          span = covered[position];
        }
        positions.set(kind, position);
        if (level === undefined && span !== undefined && span.sample_from <= row.t) {
          continue;
        }

        if (old && level === undefined) {
          continue;
        }
        const qualifying = selectedRule(rules, kind, level, old);
        if (
          qualifying?.level === level &&
          qualifying !== undefined &&
          qualifying.window.busy < qualifying.duration
        ) {
          continue;
        }
        if (qualifying === undefined) {
          if (level === undefined) {
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- all changes share the System transaction.
          await trackSample(tx, { at: row.t, kind, system, terminal: true });
          // oxlint-disable-next-line no-await-in-loop -- record recovery with its sampled span.
          await clear(tx, { kind, now: new Date(now), subject: '', system });
          current.delete(kind);
        } else {
          if (qualifying.level === level && row !== latest) {
            continue;
          }
          const reason = reasonFor(qualifying, row);
          // oxlint-disable-next-line no-await-in-loop -- level and history commit with the replay cursor.
          await raise(tx, {
            kind,
            level: qualifying.level,
            now: new Date(now),
            reason,
            subject: '',
            system,
          });
          // oxlint-disable-next-line no-await-in-loop -- metadata shares the Condition transaction.
          await trackSample(tx, { at: row.t, kind, system });
          current.set(kind, qualifying.level);
        }
      }
    }
    for (const kind of KINDS) {
      // oxlint-disable-next-line no-await-in-loop -- extend open spans through unknown evidence too.
      await trackSample(tx, { at: latest.t, kind, system });
    }
    await tx`
      INSERT INTO load_evaluations (system, through, cpu_known, memory_known, pending_from)
      VALUES (${system}, ${latest.t}, ${coverage.cpuKnown}, ${coverage.memoryKnown}, ${pendingFrom ?? null})
      ON CONFLICT (system) DO UPDATE SET through = GREATEST(load_evaluations.through, excluded.through), dirty_from = NULL, cpu_known = excluded.cpu_known, memory_known = excluded.memory_known, pending_from = excluded.pending_from
    `;
  });

// Replays new readings in sample order, including episodes already quiet by
// delivery. Each System's judgments and replay cursor commit under its row lock.
export const evaluateLoadConditions = async (
  sql: SQL,
  clock: () => number,
  limits: ConditionLimits,
) => {
  const open: { system: string }[] = await sql`
    SELECT DISTINCT system FROM conditions WHERE kind IN ${sql(KINDS)} AND cleared_at IS NULL
  `;
  const systems = new Set([...(await pairedSystems(sql)), ...open.map((row) => row.system)]);
  await evaluateEach([...systems].toSorted(), (system) => judgeSystem(sql, system, clock, limits));
};
