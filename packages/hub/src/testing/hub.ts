import { expect } from 'bun:test';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import type { Report } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { createHub } from '../hub.ts';
import { migrate } from '../migrations.ts';
import { tokenTable } from '../tokens.ts';
import { testDatabase } from './postgres.ts';

export const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

// A Hub on a fresh, migrated database that knows two Systems' tokens. The
// clock reads `clock.now`, so a test can move it between Reports.
export const startHub = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  const clock = { now: NOW };
  const errors: unknown[] = [];
  const hub = createHub({
    now: () => clock.now,
    onError: (error) => errors.push(error),
    sql: db.sql,
    tokens: tokenTable([
      { system: 'server-1', token: 'server-token' },
      { system: 'laptop-1', token: 'laptop-token' },
    ]),
  });
  return { clock, db, errors, hub, [Symbol.asyncDispose]: () => db[Symbol.asyncDispose]() };
};

export const report = (system: string, times: number[]): Report => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
  samples: times.map(sample),
  schemaVersion: REPORT_SCHEMA_VERSION,
  sentAt: NOW,
  system,
});

// Pushes a body to the ingest endpoint the way the Collector does.
export const push = (
  hub: ReturnType<typeof createHub>,
  body: unknown,
  { token }: { token?: string } = {},
) =>
  hub.fetch(
    new Request('http://hub.test/api/v1/reports', {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      method: 'POST',
    }),
  );

// Fetches the page and checks it is HTML.
export const page = async (hub: ReturnType<typeof createHub>) => {
  const response = await hub.fetch(new Request('http://hub.test/'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  return response.text();
};
