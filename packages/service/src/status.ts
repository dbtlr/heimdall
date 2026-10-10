import { tcpTargetOf } from './http-get.ts';
import type { HttpGet } from './http-get.ts';
import { displayPath } from './names.ts';

// How long `service status` waits for the Hub's health answer.
const HEALTH_TIMEOUT_MS = 2000;

// The Hub's health answer is a few dozen bytes; anything past this is not it.
const MAX_HEALTH_BODY_BYTES = 4096;

// What `GET /api/health` told `service status`. Any answer but a 200 or 503
// with the Hub's JSON body is no answer.
export type HealthAnswer =
  | { database: 'not answering' | 'ok'; kind: 'answered'; version: string }
  | { kind: 'no answer' };

const isHealthBody = (
  body: unknown,
): body is { database: 'not answering' | 'ok'; version: string } =>
  typeof body === 'object' &&
  body !== null &&
  'database' in body &&
  (body.database === 'ok' || body.database === 'not answering') &&
  'version' in body &&
  typeof body.version === 'string';

// Asks the Hub for its health with `get`, which ignores any proxy in the
// environment, so the request goes to the address the Hub listens on.
export const probeHealth = async ({
  get,
  timeoutMs = HEALTH_TIMEOUT_MS,
  url,
}: {
  get: HttpGet;
  timeoutMs?: number;
  url: string;
}): Promise<HealthAnswer> => {
  const result = await get(tcpTargetOf(url), { maxBodyBytes: MAX_HEALTH_BODY_BYTES, timeoutMs });
  if (result.kind !== 'response' || (result.status !== 200 && result.status !== 503)) {
    return { kind: 'no answer' };
  }
  try {
    const body: unknown = JSON.parse(result.body);
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

const UNITS = ['B', 'KiB', 'MiB', 'GiB'];

// A byte count in binary units: whole bytes, then one decimal from KiB up.
const sizeWords = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(bytes)} B` : `${value.toFixed(1)} ${UNITS[unit] ?? ''}`;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// A span as its largest whole unit: seconds, minutes, hours, or days.
const spanWords = (ms: number): string => {
  if (ms < MINUTE_MS) {
    return `${String(Math.max(0, Math.floor(ms / 1000)))} s`;
  }
  if (ms < HOUR_MS) {
    return `${String(Math.floor(ms / MINUTE_MS))} min`;
  }
  return ms < DAY_MS
    ? `${String(Math.floor(ms / HOUR_MS))} h`
    : `${String(Math.floor(ms / DAY_MS))} d`;
};

// The Collector's `spool` line: the transcript content the Hub has not
// acknowledged, its size and its oldest content's age, with a warning once
// that content is more than a day old (ADR-0013). `now` is epoch milliseconds.
export const spoolWords = (
  spool:
    | { problem: string }
    | { now: number; summary: { bytes: number; oldestAt: number | null } | undefined },
): string => {
  if ('problem' in spool) {
    return `unreadable (${spool.problem})`;
  }
  const { now, summary } = spool;
  if (summary === undefined) {
    return 'no spool yet; capture has not started';
  }
  if (summary.bytes === 0 || summary.oldestAt === null) {
    return 'empty';
  }
  const age = now - summary.oldestAt;
  const words = `${sizeWords(summary.bytes)} waiting, oldest spooled ${spanWords(age)} ago`;
  return age > DAY_MS ? `${words}; the Hub has not acknowledged it for over a day` : words;
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
