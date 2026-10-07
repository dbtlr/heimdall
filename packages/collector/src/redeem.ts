import { hubEndpoint } from './delivery.ts';
import { describeError } from './errors.ts';
import { asPairing } from './identity.ts';
import type { Pairing } from './identity.ts';
import { parseJson } from './json.ts';

// How the Hub answered a Pairing code (ADR-0009). Only `paired` carries a
// token; every other answer leaves the Collector's identity as it was.
export type Redemption =
  | { kind: 'paired'; pairing: Pairing }
  | { kind: 'refused' }
  | { kind: 'paused'; retryAfterSeconds: number | undefined }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'unexpected'; status: number }
  | { kind: 'malformed' }
  | { kind: 'oversized' }
  | { kind: 'dropped'; reason: string };

// The most of an answer the Collector reads: a System name and a token fit
// many times over, and nothing larger is worth holding in memory.
export const MAX_ANSWER_BYTES = 4096;

const REDEEM_TIMEOUT_MS = 30_000;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;

const retryAfter = (header: string | null) =>
  header !== null && /^\d+$/u.test(header.trim()) ? Number(header.trim()) : undefined;

type Body =
  | { kind: 'read'; text: string }
  | { kind: 'oversized' }
  | { kind: 'dropped'; reason: string };

// The answer's body as text, read no further than `MAX_ANSWER_BYTES`, whatever
// its Content-Length claims. A connection that fails mid-body, by a reset or
// the timeout, is `dropped`.
const readAnswer = async (response: Response): Promise<Body> => {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ANSWER_BYTES) {
    await response.body?.cancel().catch(() => {});
    return { kind: 'oversized' };
  }
  if (response.body === null) {
    return { kind: 'read', text: '' };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream reads one chunk at a time.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > MAX_ANSWER_BYTES) {
        break;
      }
      chunks.push(value);
    }
  } catch (error) {
    return { kind: 'dropped', reason: describeError(error) };
  }
  if (length > MAX_ANSWER_BYTES) {
    await reader.cancel().catch(() => {});
    return { kind: 'oversized' };
  }
  return { kind: 'read', text: Buffer.concat(chunks).toString('utf8') };
};

// Redeems `code`, exactly as the operator gave it, at the Hub's
// `POST /api/v1/pair`; the Hub reads its case and dash.
export const redeemCode = async ({
  code,
  hub,
  timeoutMs = REDEEM_TIMEOUT_MS,
}: {
  code: string;
  hub: URL;
  timeoutMs?: number;
}): Promise<Redemption> => {
  let response: Response;
  try {
    response = await fetch(hubEndpoint(hub, 'api/v1/pair'), {
      body: JSON.stringify({ code }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      // A redirect would turn the POST into a GET that redeems nothing.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describeError(error) };
  }
  if (response.status === 200) {
    const body = await readAnswer(response);
    if (body.kind !== 'read') {
      return body;
    }
    const pairing = asPairing(parseJson(body.text));
    return pairing === undefined ? { kind: 'malformed' } : { kind: 'paired', pairing };
  }
  await response.body?.cancel();
  if (response.status === HTTP_BAD_REQUEST) {
    return { kind: 'refused' };
  }
  if (response.status === HTTP_TOO_MANY_REQUESTS) {
    return { kind: 'paused', retryAfterSeconds: retryAfter(response.headers.get('retry-after')) };
  }
  return { kind: 'unexpected', status: response.status };
};
