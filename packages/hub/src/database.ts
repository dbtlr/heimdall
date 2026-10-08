import { SQL } from 'bun';

// The Collector gives up on a Report after 30 seconds, so a statement still
// running past that, such as one waiting on a lock, only holds a connection.
export const STATEMENT_TIMEOUT_MS = 30_000;

// A connection pool to the Hub's database, as every command opens it.
export const openDatabase = (url: URL) =>
  new SQL({ connection: { statement_timeout: STATEMENT_TIMEOUT_MS }, url: url.href });
