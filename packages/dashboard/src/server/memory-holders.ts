import type { SQL } from 'bun';

import type { MemoryHolders } from './system-detail-types.ts';

// The Collector names the holders at most once a minute; two minutes also
// covers one sample missed by a failed process read.
const CARRIER_MAX_AGE_MS = 2 * 60_000;

type Holder = MemoryHolders['processes'][number];

// The processes holding the most memory for System `system`'s sample at `t`,
// `uptimeSeconds` after its boot: the newest sample carrying a list at or
// before it, at most two minutes older and from the same boot. Undefined when
// there is none, or its list is empty. Read-only.
export const readMemoryHolders = async (
  sql: SQL,
  { system, t, uptimeSeconds }: { system: string; t: Date; uptimeSeconds: number },
): Promise<MemoryHolders | undefined> => {
  const from = Math.max(t.getTime() - CARRIER_MAX_AGE_MS, t.getTime() - uptimeSeconds * 1000);
  const [row]: { holders: Holder[]; t: Date }[] = await sql`
    SELECT t, processes->'topByMemory' AS holders
    FROM vitals_samples
    WHERE system = ${system} AND t <= ${t} AND t >= ${new Date(from)}
      AND processes->'topByMemory' IS NOT NULL
    ORDER BY t DESC
    LIMIT 1
  `;
  if (row === undefined || row.holders.length === 0) {
    return undefined;
  }
  return {
    processes: row.holders.map(({ name, pid, rssBytes }) => ({ name, pid, rssBytes })),
    t: row.t.getTime(),
  };
};

// The processes holding the most memory for System `system`'s newest sample at
// or before `at`, or its newest sample when `at` is undefined. Read-only.
export const readMemoryHoldersAsOf = async (
  sql: SQL,
  { at, system }: { at: number | undefined; system: string },
): Promise<MemoryHolders | undefined> => {
  const [inspected]: { t: Date; uptime_seconds: number }[] =
    at === undefined
      ? await sql`
          SELECT t, uptime_seconds FROM vitals_samples WHERE system = ${system}
          ORDER BY t DESC LIMIT 1
        `
      : await sql`
          SELECT t, uptime_seconds FROM vitals_samples
          WHERE system = ${system} AND t <= ${new Date(at)}
          ORDER BY t DESC LIMIT 1
        `;
  return inspected === undefined
    ? undefined
    : readMemoryHolders(sql, { system, t: inspected.t, uptimeSeconds: inspected.uptime_seconds });
};
