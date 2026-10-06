import { once } from 'node:events';

import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';
import { SQL } from 'bun';

import type { serve } from './application.ts';
import { createHub } from './hub.ts';
import { migrate } from './migrations.ts';
import { tokenTable } from './tokens.ts';

const systemCount = (n: number) => `${String(n)} ${n === 1 ? 'System' : 'Systems'}`;

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// `heimdall-hub serve`: brings the database to the latest schema, then accepts
// Reports and serves the page until systemd or a terminal stops it.
export const serveAction: ActionHandler<typeof serve> = async ({ options, out, signal, style }) => {
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  // Refuse an ambiguous token list before touching the database.
  const loadTokens = () => {
    try {
      return tokenTable(options.token);
    } catch (error) {
      return out.fatal(clean(describeError(error)));
    }
  };
  const tokens = loadTokens();

  const sql = new SQL(options.database.href);
  try {
    const applied = await migrate(sql);
    if (applied.length > 0) {
      await out.info(`Applied database migrations ${applied.join(', ')}.`);
    }
    const hub = createHub({
      now: Date.now,
      onError: (error) => {
        void out.warn(clean(`Could not answer a request: ${describeError(error)}`));
      },
      sql,
      tokens,
    });
    const server = Bun.serve({ fetch: hub.fetch, hostname: options.host, port: options.port });
    try {
      await out.info(
        clean(`Listening on ${server.url.href} for ${systemCount(options.token.length)}.`),
      );
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      await server.stop();
    }
  } finally {
    await sql.close();
  }
};
