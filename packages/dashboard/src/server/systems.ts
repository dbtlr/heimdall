import type { SQL } from 'bun';

// One paired System and when the Hub last heard from it (epoch milliseconds),
// undefined for one it has never heard from.
export type PairedSystem = { lastSeenAt: number | undefined; name: string };

// Every paired System, by name. A System is paired while it holds a token, a
// row in `paired_systems`; an unpaired one keeps its history in `systems` but
// is left out. Read-only: the dashboard never writes.
export const listPairedSystems = async (sql: SQL): Promise<PairedSystem[]> => {
  const rows: { last_seen_at: Date | null; name: string }[] = await sql`
    SELECT p.system AS name, s.last_seen_at
    FROM paired_systems p
    LEFT JOIN systems s ON s.name = p.system
    ORDER BY p.system
  `;
  return rows.map((row) => ({ lastSeenAt: row.last_seen_at?.getTime(), name: row.name }));
};
