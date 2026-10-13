import { SQL } from 'bun';

import { databaseUrl } from './database-url.ts';

// The same bound the Hub puts on its statements (packages/hub/src/database.ts).
const STATEMENT_TIMEOUT_MS = 30_000;

const open = async () =>
  new SQL({
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    url: await databaseUrl(),
  });

let connection: Promise<SQL> | undefined;

// The dashboard's one connection pool to the Hub's database, opened on first
// use. An open that fails is forgotten, so the next request tries again once
// the URL is there. Nothing here writes; queries only read.
export const database = (): Promise<SQL> => {
  connection ??= open().catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
};
