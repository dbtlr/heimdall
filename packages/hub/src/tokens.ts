import { createHash, timingSafeEqual } from 'node:crypto';

import { SYSTEM_NAME } from '@heimdall/schema';
import { z } from 'zod';

// One `system=token` entry of the Hub's token list. The token is everything
// after the first `=`, so it may hold `=` itself.
export const TokenEntrySchema = z
  .string()
  .regex(/^[^=]+=.+$/su, 'Use system=token, such as laptop-1=<token>.')
  .transform((entry) => {
    const at = entry.indexOf('=');
    return { system: entry.slice(0, at), token: entry.slice(at + 1) };
  })
  .pipe(
    z.object({
      system: z.string().regex(SYSTEM_NAME, 'Use a Fleet System name, such as laptop-1.'),
      // HTTP trims a header's trailing whitespace, so a token holding any could never match.
      token: z.string().regex(/^\S+$/u, 'A token holds no whitespace.'),
    }),
  );

export type TokenEntry = z.infer<typeof TokenEntrySchema>;

export type TokenTable = {
  // The System a bearer token belongs to, or undefined for a token no System holds.
  systemFor: (token: string) => string | undefined;
};

// Digests have one length, so comparing them reveals nothing about a token's length.
const digest = (token: string) => createHash('sha256').update(token).digest();

// The ingest token of each System, one token per System. A lookup compares the
// offered token against every entry in constant time.
export const tokenTable = (entries: readonly TokenEntry[]): TokenTable => {
  const bySystem = new Map<string, Buffer>();
  const byToken = new Map<string, string>();
  for (const { system, token } of entries) {
    if (bySystem.has(system)) {
      throw new Error(`${system} has more than one token.`);
    }
    const holder = byToken.get(token);
    if (holder !== undefined) {
      throw new Error(`${holder} and ${system} share a token.`);
    }
    bySystem.set(system, digest(token));
    byToken.set(token, system);
  }
  const digests = [...bySystem];
  return {
    systemFor: (token) => {
      const offered = digest(token);
      let match: string | undefined;
      for (const [system, held] of digests) {
        if (timingSafeEqual(offered, held)) {
          match = system;
        }
      }
      return match;
    },
  };
};
