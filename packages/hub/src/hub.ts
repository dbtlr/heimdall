import { ReportSchema } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

import { failureCap } from './failure-cap.ts';
import type { CapSlot } from './failure-cap.ts';
import { renderPage } from './page.ts';
import { readCode, redeemCode } from './pairing.ts';
import { listSystems, recordRejection, storeReport } from './store.ts';
import { systemForToken } from './tokens.ts';
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

// The largest Report body the Hub reads. The schema's 1,000 samples, each with
// several disks, come to about 1.5 MB; a larger body is a Collector bug.
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

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

// The request body as text, or undefined when it exceeds `limit` bytes. A body
// is read only as far as the limit, whatever its Content-Length claims.
const readCapped = async (request: Request, limit: number) => {
  if (request.body === null) {
    return '';
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
  return Buffer.concat(chunks).toString('utf8');
};

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
  if (pathname === '/api/v1/pair' && request.method === 'POST') {
    return pair(request, deps, pairFailures.begin());
  }
  if (pathname === '/api/health' && request.method === 'GET') {
    return health(deps);
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
