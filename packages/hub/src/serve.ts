import { once } from 'node:events';

import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';
import { SQL } from 'bun';

import type { serve } from './application.ts';
import { createHub } from './hub.ts';
import { migrate } from './migrations.ts';
import { every, pruneVitals } from './retention.ts';
import { tokenTable } from './tokens.ts';

const STATEMENT_TIMEOUT_MS = 30_000;
const PRUNE_INTERVAL_MS = 3_600_000;

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

  // The Collector gives up on a Push after 30 seconds, so a statement still
  // running past that, such as one waiting on a lock, only holds a connection.
  const sql = new SQL({
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    url: options.database.href,
  });
  try {
    // PostgreSQL's messages name the host and role, never the password.
    const applied = await migrate(sql).catch((error: unknown) =>
      out.fatal(clean(`Could not prepare the database: ${describeError(error)}`)),
    );
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
    // Pruning is routine, so only a failure is logged, and the next hour tries again.
    let stopPruning: (() => Promise<void>) | undefined;
    try {
      await out.info(
        clean(`Listening on ${server.url.href} for ${systemCount(options.token.length)}.`),
      );
      stopPruning = every({
        intervalMs: PRUNE_INTERVAL_MS,
        onError: (error) => {
          void out.warn(clean(`Could not prune old Vitals: ${describeError(error)}`));
        },
        task: () => pruneVitals(sql, Date.now()),
      });
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      // A prune still running must finish before the database closes.
      await stopPruning?.();
      await server.stop();
    }
  } finally {
    await sql.close();
  }
};
