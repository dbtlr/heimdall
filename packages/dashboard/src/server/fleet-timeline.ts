import type { SQL } from 'bun';

import { readConditionTransitions } from './condition-transitions.ts';
import type { ConditionRow } from './fleet-overview.ts';
import { toMark } from './fleet-overview.ts';
import type { FleetTimeline } from './fleet-timeline-types.ts';

// Keep the same seven-day occurrence window and Hub order as System Timelines.
// Unpairing a System retains its history and is labelled by the reader.
export const readFleetTimeline = (sql: SQL, { now }: { now: number }): Promise<FleetTimeline> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const rows: (ConditionRow & { paired: boolean })[] = await tx`
      SELECT c.id, c.system, c.kind, c.level, c.subject, c.raised_at, c.cleared_at,
             c.latest_reason, p.system IS NOT NULL AS paired
      FROM conditions c LEFT JOIN paired_systems p ON p.system = c.system
      WHERE c.cleared_at IS NULL OR c.cleared_at >= ${new Date(now - 7 * 24 * 60 * 60_000)}
      ORDER BY c.id DESC
    `;
    const transitions = await readConditionTransitions(tx, rows);
    return {
      entries: rows.map((row) =>
        Object.assign(toMark(row, transitions.get(row.id) ?? []), {
          paired: row.paired,
          reason: row.latest_reason,
          system: row.system,
        }),
      ),
      now,
    };
  });
