import { escapeControlCharacters } from '@loomcli/core';
import type { SQL } from 'bun';

import { openDatabase } from './database.ts';
import { describeError } from './errors.ts';
import { migrate } from './migrations.ts';

// The parts of a Loom action context the commands use.
type Context = {
  out: { fatal: (message: string) => never; print: (message: string) => Promise<void> };
  style: { escape: (text: string) => string };
};

// Opens the database at `url`, brings it to the latest schema, as `serve` does,
// so a command works before `serve` first runs or while it runs, and runs `work`
// against it. A failure is fatal; PostgreSQL's messages name the host and
// role, never the password, and are shown with control characters escaped.
export const withDatabase = async <T>(
  url: URL,
  { out, style }: Context,
  work: (sql: SQL) => Promise<T>,
): Promise<T> => {
  const fail = (message: string) => out.fatal(style.escape(escapeControlCharacters(message)));
  const sql = openDatabase(url);
  try {
    const applied = await migrate(sql).catch((error: unknown) =>
      fail(`Could not reach the database: ${describeError(error)}`),
    );
    if (applied.length > 0) {
      await out.print(`Applied database migrations ${applied.join(', ')}.`);
    }
    return await work(sql).catch((error: unknown) => fail(describeError(error)));
  } finally {
    await sql.close();
  }
};
