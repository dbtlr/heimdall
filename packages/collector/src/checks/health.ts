import { tcpTargetOf } from '@heimdall/service';
import type { HttpGet, HttpGetResult } from '@heimdall/service';

import { clampDetail } from './outcome.ts';
import type { ServiceOutcome } from './outcome.ts';

// How long a health URL may take to answer before the check fails.
export const HEALTH_TIMEOUT_MS = 5000;

// The check's answer. The detail is cut to what the Hub takes, so a message
// longer than expected cannot get the whole checks section refused.
const outcome = (state: ServiceOutcome['state'], detail: string): ServiceOutcome => ({
  check: 'health',
  detail: clampDetail(detail),
  state,
});

// What a request that got an answer, or none, says about the Service. A status
// outside 2xx and 3xx, and every way the Service can fail to answer, are
// unhealthy. A failure on the Collector's own side says nothing about the
// Service, so it is unknown.
const outcomeOf = (result: HttpGetResult, timeoutMs: number): ServiceOutcome => {
  if (result.kind === 'response') {
    return outcome(
      result.status >= 200 && result.status < 400 ? 'up' : 'unhealthy',
      `HTTP ${String(result.status)}`,
    );
  }
  switch (result.reason) {
    case 'timeout': {
      return outcome('unhealthy', `timed out after ${String(timeoutMs / 1000)} s`);
    }
    case 'refused': {
      return outcome('unhealthy', 'connection refused');
    }
    case 'reset': {
      return outcome('unhealthy', 'connection reset');
    }
    case 'invalid response': {
      return outcome('unhealthy', 'invalid response');
    }
    case 'error': {
      return outcome('unknown', `could not request: ${result.message}`);
    }
    default: {
      const _exhaustive: never = result.reason;
      return _exhaustive;
    }
  }
};

// Requests a Service's health URL, which record validation limits to loopback,
// with `get`, which uses no proxy and follows no redirect, so the request goes
// to that address and nowhere else. The body is not read.
export const checkHealth = async (
  url: string,
  { get, timeoutMs = HEALTH_TIMEOUT_MS }: { get: HttpGet; timeoutMs?: number | undefined },
): Promise<ServiceOutcome> =>
  outcomeOf(await get(tcpTargetOf(url), { maxBodyBytes: 0, timeoutMs }), timeoutMs);
