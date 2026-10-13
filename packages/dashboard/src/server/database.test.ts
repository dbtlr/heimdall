import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { database } from './database.ts';

const saved = { HEIMDALL_DATABASE_URL: process.env.HEIMDALL_DATABASE_URL, HOME: process.env.HOME };

afterEach(() => {
  Object.assign(process.env, saved);
});

test('opens again after a failed open, once the database URL is there', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dashboard-home-'));
  try {
    delete process.env.HEIMDALL_DATABASE_URL;
    process.env.HOME = home;
    await expect(database()).rejects.toThrow('No database URL');

    process.env.HEIMDALL_DATABASE_URL = 'postgres://db.test/heimdall';
    const sql = await database();
    expect(sql).toBeDefined();
    await sql.close();
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
