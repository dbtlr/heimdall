import { ConditionLevelSchema } from '@heimdall/schema';
import type { SQL } from 'bun';

import { laneStatus } from './fleet-overview.ts';

// Peers need only identity and health, never the Fleet's historical chart data.
// Retained history keeps its current System visible beside the paired Systems.
export const readSystemNavigation = async (
  sql: SQL,
  { name, now }: { name: string; now: number },
) => {
  const rows: {
    last_seen_at: Date | null;
    level: string | null;
    name: string;
    paired: boolean;
    sleeps: boolean | null;
  }[] = await sql`
    SELECT coalesce(p.system, s.name) AS name, p.system IS NOT NULL AS paired,
           s.last_seen_at, s.sleeps,
           (SELECT c.level FROM conditions c
            WHERE c.system = coalesce(p.system, s.name) AND c.cleared_at IS NULL
              AND c.level IN ('warning', 'alert')
            ORDER BY CASE c.level WHEN 'alert' THEN 0 ELSE 1 END LIMIT 1) AS level
    FROM paired_systems p FULL JOIN systems s ON s.name = p.system
    WHERE p.system IS NOT NULL OR s.name = ${name}
    ORDER BY coalesce(p.system, s.name)
  `;
  return rows.map((row) => ({
    level: row.level === null ? undefined : ConditionLevelSchema.parse(row.level),
    name: row.name,
    status: laneStatus({
      hasOpenCondition: row.level !== null,
      lastSeenAt: row.last_seen_at?.getTime(),
      now,
      paired: row.paired,
      sleeps: row.sleeps ?? false,
    }),
  }));
};

export type SystemNavigation = Awaited<ReturnType<typeof readSystemNavigation>>;
