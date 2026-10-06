import { ReportSchema } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

import { renderPage } from './page.ts';
import { listSystems, storeReport } from './store.ts';
import type { TokenTable } from './tokens.ts';

export type HubDependencies = {
  // The Hub's clock in epoch milliseconds: the time it receives each Report.
  now: () => number;
  // Told of each request the Hub could not answer, such as one the database refused.
  onError: (error: unknown) => void;
  sql: SQL;
  tokens: TokenTable;
};

// RFC 9110 reads the scheme name in any case.
const BEARER = /^Bearer +(?<token>\S+)$/iu;

// The largest Report body the Hub reads. The schema's 1,000 samples, each with
// several disks, come to about 1.5 MB; a larger body is a Collector bug.
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

// The reason a Report is rejected, short enough for the Collector to log.
const MAX_REASON_LENGTH = 2000;

const answer = (status: number, body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' }, status });

type Authentication =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'system'; system: string };

// Who a request's bearer token says sent it.
const authenticate = (request: Request, tokens: TokenTable): Authentication => {
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.groups?.token;
  if (token === undefined) {
    return { kind: 'missing' };
  }
  const system = tokens.systemFor(token);
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

const invalid = (reason: string) => answer(422, reason.slice(0, MAX_REASON_LENGTH));

// `POST /api/v1/reports`: 401 without a token, 403 for a token the Hub does not
// know or a Report from another System than the token's, 422 for an invalid
// Report (ADR-0004).
const ingest = async (request: Request, { now, sql, tokens }: HubDependencies) => {
  const auth = authenticate(request, tokens);
  if (auth.kind === 'missing') {
    return answer(401, "Supply the System's ingest token as a bearer token.");
  }
  if (auth.kind === 'unknown') {
    return answer(403, 'No System holds this token.');
  }
  const { system } = auth;
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
    return answer(403, `This token belongs to ${system}, not ${parsed.data.system}.`);
  }
  return Response.json(await storeReport(sql, { receivedAt: now(), report: parsed.data }));
};

const route = async (request: Request, deps: HubDependencies) => {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/v1/reports' && request.method === 'POST') {
    return ingest(request, deps);
  }
  if (pathname === '/' && request.method === 'GET') {
    const html = renderPage({ now: deps.now(), systems: await listSystems(deps.sql) });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return answer(404, 'Not found.');
};

// The Hub's HTTP surface, independent of the server that runs it. A request it
// cannot answer, such as one during a database outage, is a 503, which leaves
// the Collector's Report queued for retry (ADR-0004).
export const createHub = (deps: HubDependencies) => ({
  fetch: async (request: Request): Promise<Response> => {
    try {
      return await route(request, deps);
    } catch (error) {
      deps.onError(error);
      return answer(503, 'The Hub cannot answer right now; try again later.');
    }
  },
});
