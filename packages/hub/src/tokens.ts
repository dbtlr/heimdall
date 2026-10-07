import { createHash } from 'node:crypto';

import type { SQL } from 'bun';

const TOKEN_BYTES = 32;

// A secret's SHA-256 digest: what the Hub keeps of each token and Pairing code (ADR-0009).
export const digest = (secret: string) => createHash('sha256').update(secret).digest();

// A new ingest token: 32 random bytes, base64url without padding.
export const newToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString('base64url');

// Makes `token` the one token of `system`, replacing any it held, as of
// `pairedAt` (epoch milliseconds).
export const storeToken = async (
  sql: SQL,
  { pairedAt, system, token }: { pairedAt: number; system: string; token: string },
): Promise<void> => {
  await sql`
    INSERT INTO paired_systems (system, token_hash, paired_at)
    VALUES (${system}, ${digest(token)}, ${new Date(pairedAt)})
    ON CONFLICT (system) DO UPDATE SET
      token_hash = excluded.token_hash,
      paired_at = excluded.paired_at
  `;
};

// The paired System a bearer token belongs to, or undefined for a token no
// System holds. The lookup is by digest, so it learns nothing from the
// token's characters.
export const systemForToken = async (sql: SQL, token: string): Promise<string | undefined> => {
  const rows: { system: string }[] = await sql`
    SELECT system FROM paired_systems WHERE token_hash = ${digest(token)}
  `;
  return rows[0]?.system;
};

// How many Systems hold a token.
export const pairedSystemCount = async (sql: SQL): Promise<number> => {
  const [row]: { n: number }[] = await sql`SELECT count(*)::int AS n FROM paired_systems`;
  return row?.n ?? 0;
};
