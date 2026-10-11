import { escapeControlCharacters } from '@loomcli/core';
import type { SQL } from 'bun';

import { openDatabase } from './database.ts';
import { describeError } from './errors.ts';
import { describeLockWait, migrateWhenFree } from './migration-wait.ts';

// The parts of a Loom action context the commands use.
type Context = {
  out: { fatal: (message: string) => never; print: (message: string) => Promise<void> };
  signal?: AbortSignal;
  style: { escape: (text: string) => string };
};

// Opens the database at `url`, brings it to the latest schema, as `serve` does,
// so a command works before `serve` first runs or while it runs, and runs `work`
// against it. A failure is fatal; PostgreSQL's messages name the host and
// role, never the password, and are shown with control characters escaped. A
// lock another session holds, such as a backup's, is waited out, printing the
// holder once a minute, until the command is interrupted.
export const withDatabase = async <T>(
  url: URL,
  { out, signal, style }: Context,
  work: (sql: SQL) => Promise<T>,
): Promise<T> => {
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  const fail = (message: string) => out.fatal(clean(message));
  const sql = openDatabase(url);
  try {
    const applied = await migrateWhenFree(sql, {
      onBlocked: (holders) => out.print(clean(describeLockWait(holders))),
      ...(signal === undefined ? {} : { signal }),
    }).catch((error: unknown) => fail(`Could not reach the database: ${describeError(error)}`));
    if (applied.length > 0) {
      await out.print(`Applied database migrations ${applied.join(', ')}.`);
    }
    return await work(sql).catch((error: unknown) => fail(describeError(error)));
  } finally {
    await sql.close();
  }
};
