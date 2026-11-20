import type { SQL } from 'bun';

// A request to seed: its id, time, and token counts, for `test-model` unless
// it names another model, in Session `s-1` unless the call names another.
export type SeededRequest = {
  at: string;
  cacheRead?: number;
  cacheWrite1h?: number | null;
  cacheWrite5m?: number | null;
  id: string;
  input?: number;
  model?: string;
  output?: number;
  session?: string;
};

// Seeds a Session's requests as the projection would leave them, with the
// parser current, so the `insight` views read them.
export const seedRequests = async (
  sql: SQL,
  rows: SeededRequest[],
  { session = 's-1' }: { session?: string } = {},
) => {
  await sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now()) ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
    VALUES (1, 'laptop-1', 'claude-code', 'projects/p/s.jsonl', now(), now())
    ON CONFLICT DO NOTHING
  `;
  await sql`INSERT INTO current_parsers (harness, version) VALUES ('claude-code', 1) ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO projected_sessions (harness, parser_version, system, source, session_id)
    VALUES ('claude-code', 1, 'laptop-1', 'claude-code', ${session})
    ON CONFLICT DO NOTHING
  `;
  for (const row of rows) {
    const cacheWrite5m = row.cacheWrite5m === undefined ? 0 : row.cacheWrite5m;
    const cacheWrite1h = row.cacheWrite1h === undefined ? 0 : row.cacheWrite1h;
    // oxlint-disable-next-line no-await-in-loop -- a few rows, in order.
    await sql`
      INSERT INTO projected_requests (
        harness, parser_version, system, source, session_id, request_id, at, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, generation, byte_offset
      )
      VALUES (
        'claude-code', 1, 'laptop-1', 'claude-code', ${session}, ${row.id}, ${row.at},
        ${row.model ?? 'test-model'}, ${row.input ?? 0}, ${row.output ?? 0}, ${row.cacheRead ?? 0},
        ${(cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)}, ${cacheWrite5m}, ${cacheWrite1h}, 1, 0
      )
    `;
  }
};
