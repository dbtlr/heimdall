import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';
import type { SQL } from 'bun';

import type { pair, unpair } from './application.ts';
import { openDatabase } from './database.ts';
import { migrate } from './migrations.ts';
import { issueCode, showCode, unpair as unpairSystem } from './pairing.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The parts of a Loom action context the commands use.
type Context = {
  out: { fatal: (message: string) => never; print: (message: string) => Promise<void> };
  style: { escape: (text: string) => string };
};

// Opens the database at `url`, brings it to the latest schema, as `serve` does,
// so pairing works before `serve` first runs or while it runs, and runs `work`
// against it. A failure is fatal; PostgreSQL's messages name the host and
// role, never the password, and are shown with control characters escaped.
const withDatabase = async <T>(
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

// `heimdall-hub pair <system>`: issues a Pairing code for the System, replacing
// any code it held, and says how to redeem it (ADR-0009).
export const pairAction: ActionHandler<typeof pair> = async ({ args, options, out, style }) => {
  const { system } = args;
  const issued = await withDatabase(options.database, { out, style }, (sql) =>
    issueCode(sql, { now: Date.now(), system }),
  );
  const shown = showCode(issued.code);
  await out.print(`Pairing code for ${system}: ${shown}`);
  await out.print(`It redeems once and expires at ${new Date(issued.expiresAt).toISOString()}.`);
  if (issued.paired) {
    await out.print(`${system} is paired already. Its token works until this code is redeemed.`);
  }
  await out.print(`On ${system}, run: heimdall-collector pair ${shown}`);
};

// `heimdall-hub unpair <system>`: revokes the System's token and withdraws its
// pending code. Its history stays. A System with neither is an error, so a
// mistyped name does not pass for a revocation.
export const unpairAction: ActionHandler<typeof unpair> = async ({ args, options, out, style }) => {
  const { system } = args;
  const { revoked, withdrawn } = await withDatabase(options.database, { out, style }, (sql) =>
    unpairSystem(sql, system),
  );
  if (revoked) {
    await out.print(
      `Unpaired ${system}. Its token no longer authenticates Reports; its history stays.`,
    );
  } else if (withdrawn) {
    await out.print(`${system} was not paired. Withdrew its pending Pairing code.`);
  } else {
    out.fatal(`${system} is not paired.`);
  }
};
