import type { SQL } from 'bun';

import { digest, newToken, storeToken } from './tokens.ts';

// Crockford's base32 alphabet: no I, L, O, or U, which read as other characters.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const CODE_LENGTH = 8;

// A Pairing code typed by hand: any case, an optional dash after the fourth
// character, and whitespace around it.
const TYPED_CODE = /^(?<head>[0-9A-HJKMNP-TV-Z]{4})-?(?<tail>[0-9A-HJKMNP-TV-Z]{4})$/u;

// A new Pairing code of 8 characters, 40 random bits. Each character takes the
// low 5 bits of its own random byte; 256 is a multiple of 32, so every
// character is equally likely. Tests pass `fill` to choose the bytes.
export const newCode = (
  fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string =>
  Array.from(fill(new Uint8Array(CODE_LENGTH)), (byte) => CODE_ALPHABET[byte & 31]).join('');

// A code as the operator sees it: XXXX-XXXX.
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

// The code `typed` holds, in the form `newCode` returns, or undefined when it
// is not a code.
export const readCode = (typed: unknown): string | undefined => {
  if (typeof typed !== 'string') {
    return undefined;
  }
  // Only ASCII letters change case: `toUpperCase` would turn ß into SS.
  const upper = typed.trim().replaceAll(/[a-z]/gu, (letter) => letter.toUpperCase());
  const groups = TYPED_CODE.exec(upper)?.groups;
  return groups === undefined ? undefined : `${groups.head}${groups.tail}`;
};

// How long a Pairing code stays redeemable after it is issued.
export const CODE_LIFETIME_MS = 10 * 60_000;

// A code just issued, with when it stops redeeming (epoch milliseconds), and
// whether its System already holds a token, which redeeming the code replaces.
export type IssuedCode = { code: string; expiresAt: number; paired: boolean };

// A code's System and the new token redeeming it gave that System.
export type Pairing = { system: string; token: string };

// Codes past their expiry redeem nothing, so issuing and redeeming delete them as they go.
const deleteExpired = async (sql: SQL, now: number) => {
  await sql`DELETE FROM pairing_codes WHERE expires_at <= ${new Date(now)}`;
};

// Issues a Pairing code for `system` at `now` (epoch milliseconds), replacing
// any code the System holds. The Hub keeps only the code's digest.
export const issueCode = (
  sql: SQL,
  { now, system }: { now: number; system: string },
): Promise<IssuedCode> =>
  sql.begin(async (tx) => {
    await deleteExpired(tx, now);
    const code = newCode();
    const expiresAt = now + CODE_LIFETIME_MS;
    await tx`
      INSERT INTO pairing_codes (code_hash, system, expires_at)
      VALUES (${digest(code)}, ${system}, ${new Date(expiresAt)})
      ON CONFLICT (system) DO UPDATE SET
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at
    `;
    const paired: unknown[] = await tx`SELECT 1 FROM paired_systems WHERE system = ${system}`;
    return { code, expiresAt, paired: paired.length > 0 };
  });

// Redeems `code`, as `readCode` returns it, at `now`: a live code is spent and
// its System gets a new token, replacing its old one, all in one transaction.
// Undefined for a code that is unknown, expired, or already spent, which the
// caller must not tell apart. Of two redemptions of one code, the second waits
// on the first's delete and then finds nothing.
export const redeemCode = (
  sql: SQL,
  { code, now }: { code: string; now: number },
): Promise<Pairing | undefined> =>
  sql.begin(async (tx) => {
    await deleteExpired(tx, now);
    const [spent]: { system: string }[] = await tx`
      DELETE FROM pairing_codes
      WHERE code_hash = ${digest(code)} AND expires_at > ${new Date(now)}
      RETURNING system
    `;
    if (spent === undefined) {
      return undefined;
    }
    const token = newToken();
    await storeToken(tx, { pairedAt: now, system: spent.system, token });
    return { system: spent.system, token };
  });

// Revokes `system`'s token and withdraws its pending code, answering which of
// the two it held. The System's history stays. It takes the code row first,
// as redemption does: unpair waits for a redemption in flight to commit, then
// revokes the token it stored, and the two never lock in opposite orders.
export const unpair = (
  sql: SQL,
  system: string,
): Promise<{ revoked: boolean; withdrawn: boolean }> =>
  sql.begin(async (tx) => {
    const withdrawn: unknown[] = await tx`
      DELETE FROM pairing_codes WHERE system = ${system} RETURNING system
    `;
    const revoked: unknown[] = await tx`
      DELETE FROM paired_systems WHERE system = ${system} RETURNING system
    `;
    return { revoked: revoked.length > 0, withdrawn: withdrawn.length > 0 };
  });
