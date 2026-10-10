import { clampDetail } from './outcome.ts';
import type { ServiceOutcome } from './outcome.ts';

// How long a health URL may take to answer before the check fails.
export const HEALTH_TIMEOUT_MS = 5000;

type Request = (url: string, init: RequestInit) => Promise<Response>;

// The check's answer. The detail is cut to what the Hub takes, so an error
// message longer than expected cannot get the whole checks section refused.
const outcome = (state: 'unhealthy' | 'up', detail: string): ServiceOutcome => ({
  check: 'health',
  detail: clampDetail(detail),
  state,
});

const isNamed = (error: unknown, names: readonly string[]) =>
  error instanceof Error && names.includes(error.name);

const hasCode = (error: unknown, codes: readonly string[]) =>
  error instanceof Error && 'code' in error && codes.includes(String(error.code));

// Why a request failed, in a few words. Anything unexpected keeps the error's
// own message.
const failure = (error: unknown, timeoutMs: number): string => {
  if (isNamed(error, ['TimeoutError', 'AbortError'])) {
    return `timed out after ${String(timeoutMs / 1000)} s`;
  }
  if (hasCode(error, ['ConnectionRefused', 'ECONNREFUSED'])) {
    return 'connection refused';
  }
  if (hasCode(error, ['ECONNRESET', 'ConnectionClosed'])) {
    return 'connection reset';
  }
  return error instanceof Error ? error.message : 'request failed';
};

// Requests a Service's health URL, which record validation limits to loopback.
// A 2xx or 3xx status is up; any other status, a refused or reset connection,
// or no answer within the timeout is unhealthy. A redirect is never followed,
// so the request cannot leave loopback, and the body is discarded unread.
export const checkHealth = async (
  url: string,
  {
    request = (target, init) => fetch(target, init),
    timeoutMs = HEALTH_TIMEOUT_MS,
  }: { request?: Request; timeoutMs?: number | undefined } = {},
): Promise<ServiceOutcome> => {
  try {
    const response = await request(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The status is the answer; a body that will not cancel changes nothing.
    await response.body?.cancel().catch(() => undefined);
    const passes = response.status >= 200 && response.status < 400;
    return outcome(passes ? 'up' : 'unhealthy', `HTTP ${String(response.status)}`);
  } catch (error) {
    return outcome('unhealthy', failure(error, timeoutMs));
  }
};
