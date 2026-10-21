import type { SQL } from 'bun';

// When each of `systems` stops being silenced, for those silenced at `now`.
// A silence that has ended stays in the table and holds nothing. Mirrors the
// Hub's own `activeSilences`.
export const readSilencedUntil = async (
  sql: SQL,
  { now, systems }: { now: number; systems: readonly string[] },
): Promise<Map<string, number>> => {
  const rows: { system: string; until: Date }[] = await sql`
    SELECT system, until FROM silences
    WHERE system IN ${sql(systems)} AND until > ${new Date(now)}
  `;
  return new Map(rows.map(({ system, until }) => [system, until.getTime()]));
};
