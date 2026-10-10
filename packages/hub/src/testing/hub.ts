import { expect } from 'bun:test';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';

import { REPORT_SCHEMA_VERSION, TRANSCRIPT_OFFSET_HEADER } from '@heimdall/schema';
import type { Report } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { createHub } from '../hub.ts';
import { migrate } from '../migrations.ts';
import { issueCode } from '../pairing.ts';
import { storeToken } from '../tokens.ts';
import { testDatabase } from './postgres.ts';

// gzip, as the Collector packs a chunk.
export const gzip = promisify(gzipCallback);

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

// The times of a sample every 15 seconds from `from` until before `to` (epoch
// milliseconds): the span a System was awake for.
export const sampleTimes = (from: number, to: number) =>
  Array.from({ length: Math.floor((to - from) / 15_000) }, (_, i) => from + i * 15_000);

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

const bearer = (token: string | undefined): Record<string, string> =>
  token === undefined ? {} : { authorization: `Bearer ${token}` };

// Opens a transcript generation the way the Collector does (ADR-0013).
export const openGeneration = (
  hub: ReturnType<typeof createHub>,
  body: unknown,
  { token }: { token?: string } = {},
) =>
  hub.fetch(
    new Request('http://hub.test/api/v1/transcripts/generations', {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...bearer(token) },
      method: 'POST',
    }),
  );

// Sends one transcript chunk the way the Collector does: `content` is gzipped
// unless it is bytes already, and `offset` is omitted when undefined.
export const sendChunk = async (
  hub: ReturnType<typeof createHub>,
  generation: number | string,
  {
    content,
    offset,
    token,
  }: { content: string | Uint8Array; offset?: number | string; token?: string },
) =>
  hub.fetch(
    new Request(`http://hub.test/api/v1/transcripts/generations/${String(generation)}/chunks`, {
      body: typeof content === 'string' ? await gzip(content) : content,
      headers: {
        'content-type': 'application/gzip',
        ...bearer(token),
        ...(offset === undefined ? {} : { [TRANSCRIPT_OFFSET_HEADER]: String(offset) }),
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
