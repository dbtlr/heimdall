import { displayPath } from './names.ts';

// How long `service status` waits for the Hub's health answer.
const HEALTH_TIMEOUT_MS = 2000;

// What `GET /api/health` told `service status`. Any answer but a 200 or 503
// with the Hub's JSON body is no answer.
export type HealthAnswer =
  | { database: 'not answering' | 'ok'; kind: 'answered'; version: string }
  | { kind: 'no answer' };

export type HealthFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const isHealthBody = (
  body: unknown,
): body is { database: 'not answering' | 'ok'; version: string } =>
  typeof body === 'object' &&
  body !== null &&
  'database' in body &&
  (body.database === 'ok' || body.database === 'not answering') &&
  'version' in body &&
  typeof body.version === 'string';

export const probeHealth = async ({
  fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
  url,
}: {
  fetch: HealthFetch;
  timeoutMs?: number;
  url: string;
}): Promise<HealthAnswer> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200 && response.status !== 503) {
      return { kind: 'no answer' };
    }
    const body: unknown = await response.json();
    return isHealthBody(body)
      ? { database: body.database, kind: 'answered', version: body.version }
      : { kind: 'no answer' };
  } catch {
    return { kind: 'no answer' };
  }
};

const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]']);

// Where to ask the Hub for its health: the address it listens on, or loopback
// when it listens on every address or names none. An IPv6 address is bracketed.
export const healthUrl = (host: unknown, port: number): string => {
  const address = typeof host === 'string' && !WILDCARDS.has(host) ? host : '127.0.0.1';
  const shown = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  return `http://${shown}:${String(port)}/api/health`;
};

// The `health` line: the database's state and the running version, with
// `restart pending` whenever that differs from this binary's own version,
// which covers an upgrade and a rollback alike.
export const healthWords = (answer: HealthAnswer, ownVersion: string, url: string): string => {
  if (answer.kind === 'no answer') {
    return `no answer (${url})`;
  }
  const state = answer.database === 'ok' ? 'ok' : 'database not answering';
  const words = `${state}, v${answer.version} (${url})`;
  return answer.version === ownVersion
    ? words
    : `${words}; restart pending, this binary is v${ownVersion}`;
};

// The Collector's `queue` line, from the samples counted or why they were not.
export const queueWords = (
  depth: { problem: string } | { samples: number | undefined },
): string => {
  if ('problem' in depth) {
    return `unreadable (${depth.problem})`;
  }
  if (depth.samples === undefined) {
    return 'no queue yet; run has not started';
  }
  return `${String(depth.samples)} ${depth.samples === 1 ? 'sample' : 'samples'} waiting`;
};

// The Collector's `system` line: the System it is paired as and the Hub it
// paired with, a mismatch with the configured Hub's origin, or how to pair.
// It never names the token.
export const systemWords = (
  identity:
    | { configured: string | undefined; paired: { hub: string; system: string } | undefined }
    | { problem: string },
  program: string,
): string => {
  const pairing = `run ${program} pair <code>`;
  if ('problem' in identity) {
    return `not paired (${identity.problem}); ${pairing}`;
  }
  const { configured, paired } = identity;
  if (paired === undefined) {
    return `not paired; ${pairing}`;
  }
  return configured === undefined || configured === paired.hub
    ? `${paired.system} (paired with ${paired.hub})`
    : `${paired.system}, paired with ${paired.hub} but configured for ${configured}; pair again`;
};

export type StatusReport = {
  details: (readonly [string, string])[];
  home: string;
  label: string;
  notes: string[];
  paths: { config: string; log: string; unit?: string };
  summary: string;
};

const row = (name: string, words: string) => `  ${name.padEnd(9)}${words}`;

// The plain text `service status` prints: the unit's state on the first line,
// then one aligned line for each detail, path, and note. It has no final line
// break, which the printing adds.
export const renderStatus = ({
  details,
  home,
  label,
  notes,
  paths,
  summary,
}: StatusReport): string =>
  [
    `${label}: ${summary}`,
    ...details.map(([name, words]) => row(name, words)),
    ...(paths.unit === undefined ? [] : [row('unit', displayPath(paths.unit, home))]),
    row('log', displayPath(paths.log, home)),
    row('config', displayPath(paths.config, home)),
    ...notes.map((note) => row('note', note)),
  ].join('\n');
