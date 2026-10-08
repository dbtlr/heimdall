import { expect } from 'bun:test';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import type { Report } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { createHub } from '../hub.ts';
import { migrate } from '../migrations.ts';
import { issueCode } from '../pairing.ts';
import { storeToken } from '../tokens.ts';
import { testDatabase } from './postgres.ts';

export const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

// A Hub on a fresh, migrated database where two Systems are paired, with
// tokens a test can name. The wall clock reads `clock.now` and the monotonic
// clock `clock.elapsed`, so a test can move either between requests.
export const startHub = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  await storeToken(db.sql, { pairedAt: NOW, system: 'server-1', token: 'server-token' });
  await storeToken(db.sql, { pairedAt: NOW, system: 'laptop-1', token: 'laptop-token' });
  const clock = { elapsed: 0, now: NOW };
  const errors: unknown[] = [];
  const hub = createHub({
    elapsed: () => clock.elapsed,
    now: () => clock.now,
    onError: (error) => errors.push(error),
    sql: db.sql,
  });
  return { clock, db, errors, hub, [Symbol.asyncDispose]: () => db[Symbol.asyncDispose]() };
};

export type Hub = Awaited<ReturnType<typeof startHub>>;

// Issues a Pairing code for `system` at the Hub's current time, as `heimdall-hub pair` does.
export const issue = async (h: Hub, system: string) =>
  (await issueCode(h.db.sql, { now: h.clock.now, system })).code;

export const report = (system: string, times: number[]): Report => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
  samples: times.map(sample),
  schemaVersion: REPORT_SCHEMA_VERSION,
  sentAt: NOW,
  system,
});

// Sends a body to the ingest endpoint the way the Collector does.
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

// Redeems a Pairing code the way the Collector does.
export const redeem = (hub: ReturnType<typeof createHub>, body: unknown) =>
  hub.fetch(
    new Request('http://hub.test/api/v1/pair', {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
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

// A TCP server on a free port that accepts connections and never replies.
export const silentServer = () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {} } });
  return { port: server.port, [Symbol.asyncDispose]: async () => server.stop(true) };
};
