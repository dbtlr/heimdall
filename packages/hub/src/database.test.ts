import { expect, test } from 'bun:test';

import { openDatabase } from './database.ts';
import { testDatabase } from './testing/postgres.ts';

// The Collector gives up on a Push after 30 seconds, and `pair` and `unpair`
// should not wait on a lock forever either.
test("statements on the Hub's connections give up after 30 seconds", async () => {
  await using db = await testDatabase();
  await using sql = openDatabase(db.url);

  const [row]: { statement_timeout: string }[] = await sql`SHOW statement_timeout`;

  expect(row?.statement_timeout).toBe('30s');
});
