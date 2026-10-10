import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import {
  MAX_TRANSCRIPT_CHUNK_BYTES,
  MAX_TRANSCRIPT_REQUEST_BYTES,
  OpenGenerationSchema,
  ReportSchema,
  TRANSCRIPT_OFFSET_HEADER,
} from '@heimdall/schema';
import type { ChunkAccepted, GenerationOpened } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

import { failureCap } from './failure-cap.ts';
import type { CapSlot } from './failure-cap.ts';
import { renderPage } from './page.ts';
import { readCode, redeemCode } from './pairing.ts';
import { readRecords } from './records.ts';
import { listSystems, recordRejection, seeSystem, storeReport } from './store.ts';
import { systemForToken } from './tokens.ts';
import { appendChunk, openGeneration } from './transcripts.ts';
import { HUB_VERSION } from './version.ts';

export type HubDependencies = {
  // A monotonic clock in milliseconds that times the Pairing failure cap's
  // window, so a wall clock stepped back or forward cannot stretch or end a
  // lockout; defaults to performance.now.
  elapsed?: () => number;
  // How long the health check waits for the database; defaults to HEALTH_TIMEOUT_MS.
  healthTimeoutMs?: number;
  // The Hub's clock in epoch milliseconds: the time it receives each Report or
  // redeems a Pairing code.
  now: () => number;
  // Told of each request the Hub could not answer, such as one the database refused.
  onError: (error: unknown) => void;
  sql: SQL;
};

// RFC 9110 reads the scheme name in any case.
const BEARER = /^Bearer +(?<token>\S+)$/iu;

// The largest Report body the Hub reads. It fits the 8 MiB a Collector may
// spend on its record set plus a full batch of samples: the schema's 1,000
// samples, each with several disks, come to about 1.5 MB. A larger body is a
// Collector bug.
export const MAX_REPORT_BYTES = 12 * 1024 * 1024;

// The largest Pairing request body the Hub reads; `{"code":"XXXX-XXXX"}` is 20 bytes.
const MAX_PAIR_BYTES = 1024;

// Failed redemptions the Hub allows in any rolling minute, across every
// client. With codes valid for 10 minutes, at most 100 guesses fit in a
// code's life, against 2^40 codes (ADR-0009).
const PAIR_FAILURES_PER_MINUTE = 10;

// The one answer every failed redemption gets, whatever failed.
const PAIR_FAILURE = { error: 'invalid or expired code' };

// The reason a Report is rejected, short enough for the Collector to log.
const MAX_REASON_LENGTH = 2000;

// How long `GET /api/health` waits for the database. The statement timeout is
// 30 s, far longer than Fleet's health-check poll window.
const HEALTH_TIMEOUT_MS = 2000;

const answer = (status: number, body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' }, status });

type Authentication =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'system'; system: string };

// Who a request's bearer token says sent it, by the paired Systems' tokens.
const authenticate = async (request: Request, sql: SQL): Promise<Authentication> => {
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.groups?.token;
  if (token === undefined) {
    return { kind: 'missing' };
  }
  const system = await systemForToken(sql, token);
  return system === undefined ? { kind: 'unknown' } : { kind: 'system', system };
};

// The request body, or undefined when it exceeds `limit` bytes. A body is read
// only as far as the limit, whatever its Content-Length claims.
const readBytes = async (request: Request, limit: number) => {
  if (request.body === null) {
    return Buffer.alloc(0);
  }
  if (Number(request.headers.get('content-length') ?? 0) > limit) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

// The request body as text, or undefined when it exceeds `limit` bytes.
const readCapped = async (request: Request, limit: number) =>
  (await readBytes(request, limit))?.toString('utf8');

const parseJson = (body: string): { kind: 'json'; value: unknown } | { kind: 'invalid' } => {
  try {
    return { kind: 'json', value: JSON.parse(body) };
  } catch {
    return { kind: 'invalid' };
  }
};

// `POST /api/v1/reports`: 401 without a token, 403 for a token the Hub does not
// know or a Report from another System than the token's, 422 for an invalid
// Report (ADR-0004). A Report the token attributes to a System counts as seeing
// that System even when rejected, and raises its Reports-rejected Condition
// (ADR-0005).
const ingest = async (request: Request, { now, onError, sql }: HubDependencies) => {
  const auth = await authenticate(request, sql);
  if (auth.kind === 'missing') {
    return answer(401, "Supply the System's ingest token as a bearer token.");
  }
  if (auth.kind === 'unknown') {
    return answer(403, 'No System holds this token.');
  }
  const { system } = auth;
  const reject = async (status: 403 | 422, reason: string) => {
    const shown = reason.slice(0, MAX_REASON_LENGTH);
    // The answer tells the Collector whether to drop the Report, so it stands
    // even when the database cannot record the rejection (ADR-0004).
    await recordRejection(sql, { reason: shown, receivedAt: now(), system }).catch(onError);
    return answer(status, shown);
  };
  const invalid = (reason: string) => reject(422, reason);
  const body = await readCapped(request, MAX_REPORT_BYTES);
  if (body === undefined) {
    return invalid(`The Report exceeds ${String(MAX_REPORT_BYTES)} bytes.`);
  }
  const json = parseJson(body);
  if (json.kind === 'invalid') {
    return invalid('The Report is not JSON.');
  }
  const parsed = ReportSchema.safeParse(json.value);
  if (!parsed.success) {
    return invalid(z.prettifyError(parsed.error));
  }
  if (parsed.data.system !== system) {
    return reject(403, `This token belongs to ${system}, not ${parsed.data.system}.`);
  }
  return Response.json(await storeReport(sql, { receivedAt: now(), report: parsed.data }));
};

// The System a transcript upload's token names, or the answer to a request
// whose token names none. An upload never raises a Condition (ADR-0013).
const uploader = async (request: Request, sql: SQL) => {
  const auth = await authenticate(request, sql);
  if (auth.kind === 'missing') {
    return answer(401, "Supply the System's ingest token as a bearer token.");
  }
  if (auth.kind === 'unknown') {
    return answer(403, 'No System holds this token.');
  }
  return auth.system;
};

// The largest request body that opens a generation: a path of up to 4096
// bytes of UTF-8, which JSON escapes to at most six bytes each.
const MAX_OPEN_BYTES = 32 * 1024;

const DELETED = 'This transcript was deleted on purpose; do not upload it again.';

// `POST /api/v1/transcripts/generations`: opens a generation of a file for
// the token's System and answers its identifier, or 410 when the file's path
// was deleted on purpose (ADR-0013).
const open = async (request: Request, { now, sql }: HubDependencies) => {
  const system = await uploader(request, sql);
  if (typeof system !== 'string') {
    return system;
  }
  const body = await readCapped(request, MAX_OPEN_BYTES);
  const json = body === undefined ? undefined : parseJson(body);
  const parsed = OpenGenerationSchema.safeParse(json?.kind === 'json' ? json.value : undefined);
  if (!parsed.success) {
    await seeSystem(sql, { at: now(), system });
    return answer(422, z.prettifyError(parsed.error));
  }
  const opened = await openGeneration(sql, { ...parsed.data, now: now(), system });
  if (opened.kind === 'deleted') {
    return answer(410, DELETED);
  }
  const answered: GenerationOpened = { generation: opened.generation, held: 0 };
  return Response.json(answered, { status: 201 });
};

// The answer for a chunk of a generation its System did not open.
const NO_SUCH_GENERATION = 'This System opened no such generation.';

// A generation's chunk endpoint; the identifier is a positive integer, and
// one past the safe integers names no generation (ADR-0013).
const CHUNK_PATH = /^\/api\/v1\/transcripts\/generations\/(?<generation>[1-9]\d{0,15})\/chunks$/u;

// A chunk's offset as its header carries it: a safe, non-negative integer.
const OFFSET = /^(?:0|[1-9]\d{0,15})$/u;

const offsetOf = (request: Request) => {
  const header = request.headers.get(TRANSCRIPT_OFFSET_HEADER) ?? '';
  const offset = OFFSET.test(header) ? Number(header) : Number.NaN;
  return Number.isSafeInteger(offset) ? offset : undefined;
};

// How many bytes of the file a gzipped chunk holds, or undefined when it is
// not gzip or unpacks past the chunk limit. Unpacking stops at the limit, so
// a small body cannot expand without bound.
const gunzip = promisify(gunzipCallback);

const unpackedLength = async (content: Buffer) => {
  try {
    return (await gunzip(content, { maxOutputLength: MAX_TRANSCRIPT_CHUNK_BYTES })).byteLength;
  } catch {
    return undefined;
  }
};

// `POST /api/v1/transcripts/generations/<id>/chunks`: stores a gzipped chunk at
// the offset the Hub holds for the generation and answers the new total, or,
// at any other offset, 409 with what it holds (ADR-0013).
const append = async (request: Request, { now, sql }: HubDependencies, generation: number) => {
  const system = await uploader(request, sql);
  if (typeof system !== 'string') {
    return system;
  }
  const refuse = async (status: 404 | 413 | 422, reason: string) => {
    await seeSystem(sql, { at: now(), system });
    return answer(status, reason);
  };
  if (!Number.isSafeInteger(generation)) {
    return refuse(404, NO_SUCH_GENERATION);
  }
  const offset = offsetOf(request);
  if (offset === undefined) {
    return refuse(422, `Give the chunk's offset in the file as ${TRANSCRIPT_OFFSET_HEADER}.`);
  }
  const content = await readBytes(request, MAX_TRANSCRIPT_REQUEST_BYTES);
  if (content === undefined) {
    return refuse(413, `A chunk exceeds ${String(MAX_TRANSCRIPT_REQUEST_BYTES)} bytes.`);
  }
  const length = await unpackedLength(content);
  if (length === undefined) {
    return refuse(
      422,
      `A chunk must be gzip of at most ${String(MAX_TRANSCRIPT_CHUNK_BYTES)} bytes of the file.`,
    );
  }
  const appended = await appendChunk(sql, {
    content,
    generation,
    length,
    now: now(),
    offset,
    system,
  });
  if (appended.kind === 'unknown') {
    return answer(404, NO_SUCH_GENERATION);
  }
  if (appended.kind === 'deleted') {
    return answer(410, DELETED);
  }
  const answered: ChunkAccepted = { held: appended.held };
  return Response.json(answered, { status: appended.kind === 'held' ? 200 : 409 });
};

// The code a Pairing request body holds, or undefined for any body that does
// not hold one.
const codeIn = (body: string | undefined) => {
  const json = body === undefined ? undefined : parseJson(body);
  if (json?.kind !== 'json' || typeof json.value !== 'object' || json.value === null) {
    return undefined;
  }
  return readCode((json.value as { code?: unknown }).code);
};

// `POST /api/v1/pair`: redeems a Pairing code for its System's name and a new
// token (ADR-0009). Every failure, from a malformed body to a spent code,
// answers the same 400, and only a success stops counting against the
// failure cap. A full cap answers 429 without reading the code.
const pair = async (request: Request, { now, sql }: HubDependencies, slot: CapSlot) => {
  if (slot.kind === 'refused') {
    return Response.json(
      { error: 'too many failed codes; try again later' },
      { headers: { 'retry-after': String(Math.ceil(slot.retryAfterMs / 1000)) }, status: 429 },
    );
  }
  const code = codeIn(await readCapped(request, MAX_PAIR_BYTES));
  const pairing = code === undefined ? undefined : await redeemCode(sql, { code, now: now() });
  if (pairing === undefined) {
    return Response.json(PAIR_FAILURE, { status: 400 });
  }
  slot.succeeded();
  return Response.json(pairing, { headers: { 'cache-control': 'no-store' } });
};

// `GET /api/health`: 200 when the database answers a trivial query within the
// timeout, 503 when it does not. A failed check answers directly rather than
// through `onError`, so an outage does not log on every poll.
const health = async ({ healthTimeoutMs = HEALTH_TIMEOUT_MS, sql }: HubDependencies) => {
  const answered = await Promise.race([
    Promise.resolve(sql`SELECT 1`).then(
      () => true,
      () => false,
    ),
    Bun.sleep(healthTimeoutMs).then(() => false),
  ]);
  return Response.json(
    { database: answered ? 'ok' : 'not answering', version: HUB_VERSION },
    { status: answered ? 200 : 503 },
  );
};

const route = async (
  request: Request,
  deps: HubDependencies,
  pairFailures: ReturnType<typeof failureCap>,
) => {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/v1/reports' && request.method === 'POST') {
    return ingest(request, deps);
  }
  if (pathname === '/api/v1/transcripts/generations' && request.method === 'POST') {
    return open(request, deps);
  }
  const chunkOf = CHUNK_PATH.exec(pathname)?.groups?.generation;
  if (chunkOf !== undefined && request.method === 'POST') {
    return append(request, deps, Number(chunkOf));
  }
  if (pathname === '/api/v1/pair' && request.method === 'POST') {
    return pair(request, deps, pairFailures.begin());
  }
  if (pathname === '/api/health' && request.method === 'GET') {
    return health(deps);
  }
  if (pathname === '/api/v1/records' && request.method === 'GET') {
    return Response.json({ systems: await readRecords(deps.sql) });
  }
  if (pathname === '/' && request.method === 'GET') {
    const html = renderPage({ now: deps.now(), systems: await listSystems(deps.sql) });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return answer(404, 'Not found.');
};

// The Hub's HTTP surface, independent of the server that runs it. A request it
// cannot answer, such as one during a database outage, is a 503, which leaves
// the Collector's Report queued for retry (ADR-0004). One Hub holds one failure
// cap for Pairing, so a process runs one Hub.
export const createHub = (deps: HubDependencies) => {
  const pairFailures = failureCap({
    clock: deps.elapsed ?? (() => performance.now()),
    limit: PAIR_FAILURES_PER_MINUTE,
    windowMs: 60_000,
  });
  return {
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await route(request, deps, pairFailures);
      } catch (error) {
        deps.onError(error);
        return answer(503, 'The Hub cannot answer right now; try again later.');
      }
    },
  };
};
