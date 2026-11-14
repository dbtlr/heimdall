import type { SQL } from 'bun';

import { vitalsSource } from '../lib/vitals-window.ts';
import { readConditionLimits } from './condition-limits.ts';
import { bucketStart } from './fleet-overview.ts';
import type { VitalsPoint, VitalsWindow } from './vitals-window-types.ts';

type Reading = { cpu: number | null; load: number | null; memory: number | null; t: Date };

// The platform the System's Collector last reported, if any.
export const readPlatform = async (sql: SQL, system: string): Promise<string | undefined> => {
  const [row]: { collector_platform: string | null }[] = await sql`
    SELECT collector_platform FROM systems WHERE name = ${system}
  `;
  return row?.collector_platform ?? undefined;
};

// Raw samples of the window, the way a rollup would average them.
const readSamples = (sql: SQL, system: string, from: Date, to: Date): Promise<Reading[]> => sql`
  SELECT t, cpu_busy_percent AS cpu,
         (memory_used_bytes::float8 / NULLIF(memory_total_bytes, 0) * 100) AS memory,
         load_1 AS load
  FROM vitals_samples
  WHERE system = ${system} AND t >= ${from} AND t <= ${to}
  ORDER BY t
`;

// The 5-minute rollups from the one holding the window's start through the one
// holding its end.
const readRollups = (sql: SQL, system: string, from: Date, to: Date): Promise<Reading[]> => sql`
  SELECT bucket AS t,
         (cpu_busy_sum / samples)::float8 AS cpu,
         (memory_used_sum / samples / NULLIF(memory_total_max, 0) * 100)::float8 AS memory,
         (load_1_sum / samples)::float8 AS load
  FROM vitals_rollups
  WHERE system = ${system} AND bucket >= ${new Date(bucketStart(from.getTime()))} AND bucket <= ${to}
  ORDER BY bucket
`;

// The System's CPU, memory, and load from `from` to `to`, from raw samples while
// the window is short and within their retention, else from the 5-minute
// rollups, so the rows read follow the window. `to` is held to `now`. Read-only.
export const readVitalsWindow = async (
  sql: SQL,
  { from, now, system, to }: { from: number; now: number; system: string; to: number },
): Promise<VitalsWindow> => {
  const end = Math.min(to, now);
  const source = vitalsSource({ from, to: end }, now);
  const [rows, limits, platform] = await Promise.all([
    (source === 'samples' ? readSamples : readRollups)(sql, system, new Date(from), new Date(end)),
    readConditionLimits(sql, system),
    readPlatform(sql, system),
  ]);
  const points: VitalsPoint[] = rows.map((row) => ({
    cpu: row.cpu,
    load: row.load,
    memory: row.memory,
    t: row.t.getTime(),
  }));
  return {
    from,
    limits: {
      cpuPercent: limits?.cpu.percent,
      memoryPercent: platform === 'darwin' ? undefined : limits?.memory.percent,
    },
    points,
    source,
    to: end,
  };
};
