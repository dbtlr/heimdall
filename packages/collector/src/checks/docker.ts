import type { ServiceCheckState } from '@heimdall/schema';
import type { HttpGet, HttpGetResult } from '@heimdall/service';

import type { StopFacts } from './stop-log.ts';

// What one container check found, before the supervisor check clamps the
// detail, and the container's stop facts when the Engine answered for it with
// times the Collector can read.
export type ContainerOutcome = { detail: string; state: ServiceCheckState; stopFacts?: StopFacts };

// Where the Docker Engine listens: a unix socket, or an address this Collector
// cannot talk to (`DOCKER_HOST` names another transport).
export type DockerEndpoint = { kind: 'unix'; path: string } | { host: string; kind: 'unsupported' };

// What a container check needs from the System: the Engine's endpoint, and how
// long to wait for it (tests shorten it).
export type DockerTools = { endpoint: DockerEndpoint; timeoutMs?: number };

// How long the Engine has to answer before the check is unknown.
const DOCKER_TIMEOUT_MS = 5000;

// The Engine socket the Collector's account uses. `DOCKER_HOST` decides when it
// is set. Otherwise Docker runs rootless under this account, whose socket is
// `docker.sock` in its runtime directory, `XDG_RUNTIME_DIR` or
// `/run/user/<uid>`. The Collector never reads Docker's own config.
export const dockerEndpoint = ({
  env = process.env,
  uid = process.getuid?.() ?? 0,
}: {
  env?: Record<string, string | undefined>;
  uid?: number;
} = {}): DockerEndpoint => {
  const host = env.DOCKER_HOST;
  if (host !== undefined && host !== '') {
    const path = /^unix:\/\/(\/.+)$/u.exec(host)?.[1];
    return path === undefined ? { host, kind: 'unsupported' } : { kind: 'unix', path };
  }
  const runtimeDir = env.XDG_RUNTIME_DIR;
  const dir =
    runtimeDir?.startsWith('/') === true
      ? runtimeDir.replace(/\/+$/u, '')
      : `/run/user/${String(uid)}`;
  return { kind: 'unix', path: `${dir}/docker.sock` };
};

const unknown = (detail: string): ContainerOutcome => ({ detail, state: 'unknown' });

// The most of an answer the check reads. An inspect result is a few KiB; the
// cap keeps a wrong or hostile listener on the socket from filling memory.
const MAX_ANSWER_BYTES = 1024 * 1024;

// A recorded value that can be a container ID or a prefix of one: Docker
// shows 12 hex digits and the full ID has 64.
const HEX_ID = /^[0-9a-f]{12,64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Whether a 404 body is the Engine saying the container does not exist. Docker
// and Podman both put "no such container" in the message; a 404 from anything
// else, such as a proxy's "page not found", says nothing about the container.
const saysNoSuchContainer = (text: string): boolean => {
  const body = parseJson(text);
  return (
    isRecord(body) &&
    typeof body.message === 'string' &&
    body.message.toLowerCase().includes('no such container')
  );
};

// Whether the inspect result is for the container asked for. The Engine looks
// a name up as an exact name and then as an ID prefix, so an all-hex name such
// as `cafe` can be answered with another container whose ID starts with it.
// undefined when the result names neither a Name nor an Id.
const isForContainer = (body: Record<string, unknown>, container: string): boolean | undefined => {
  const { Id: id, Name: name } = body;
  if (typeof name !== 'string' && typeof id !== 'string') {
    return undefined;
  }
  return (
    name === `/${container}` ||
    (HEX_ID.test(container) && typeof id === 'string' && id.startsWith(container))
  );
};

// The Engine's time for a time it does not hold, such as the finish of a
// container that never stopped.
const ZERO_TIME = '0001-01-01T00:00:00Z';

// A time as the Engine prints it, RFC 3339 to the nanosecond, in UTC from
// Docker and with an offset from Podman, in epoch milliseconds, or null for the
// zero time. Undefined for a value of any other shape.
const engineTime = (value: unknown): number | null | undefined => {
  if (value === ZERO_TIME) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(
    value,
  );
  if (match === null) {
    return undefined;
  }
  const parsed = Date.parse(`${match[1] ?? ''}${(match[2] ?? '').slice(0, 4)}${match[3] ?? ''}`);
  return Number.isNaN(parsed) ? undefined : parsed;
};

// How a container's last run ended, while the Engine still holds it: it forgets
// the exit code and the out-of-memory kill when the container starts again,
// and a container that was only created has never ended.
const lastRun = (
  state: Record<string, unknown>,
  status: string | undefined,
): Pick<StopFacts, 'exitStatus' | 'result'> => {
  const { ExitCode: code, OOMKilled: oom } = state;
  if (
    (status !== 'exited' && status !== 'dead' && status !== 'restarting') ||
    typeof code !== 'number' ||
    !Number.isInteger(code) ||
    Math.abs(code) >= 1e9
  ) {
    return { exitStatus: null, result: null };
  }
  if (oom === true) {
    return { exitStatus: code, result: 'oom-kill' };
  }
  return { exitStatus: code, result: code === 0 ? 'success' : 'exit-code' };
};

// What the Engine holds about a container that the stop log compares
// (ADR-0021), or undefined when a time is missing or in a form the Collector
// cannot read, so a check infers nothing from it. A container that never
// stopped takes its creation as when it last stopped, since the Engine forgets
// the container it replaced, so a recreated container is a stop from its
// creation to its start. Only a running container is running: a pause holds no
// time, so it is no stop, and one restarting is stopped. `RestartCount` counts
// the restarts its restart policy made, and a manual start sets it back to 0.
const containerStopFacts = (
  body: Record<string, unknown>,
  state: Record<string, unknown>,
  status: string | undefined,
): StopFacts | undefined => {
  const created = engineTime(body.Created);
  const finished = engineTime(state.FinishedAt);
  const startedAt = engineTime(state.StartedAt);
  const { RestartCount: restarts } = body;
  if (
    created === undefined ||
    finished === undefined ||
    startedAt === undefined ||
    typeof restarts !== 'number' ||
    !Number.isSafeInteger(restarts)
  ) {
    return undefined;
  }
  return {
    ...lastRun(state, status),
    restarts: Math.max(0, restarts),
    running: status === 'running',
    startedAt,
    stoppedAt: finished ?? created,
  };
};

// A container's state from the Engine's `GET /containers/<id>/json` body. The
// Engine says Running for a paused container and for one between restarts, so
// the status decides those; Docker's own healthcheck is not read, since the
// health URL covers health. The exit code is only meaningful once a container
// has run and stopped. A container's state carries its stop facts when they can
// be read.
const containerOutcome = (body: unknown, container: string): ContainerOutcome => {
  if (!isRecord(body) || !isRecord(body.State) || typeof body.State.Running !== 'boolean') {
    return unknown('unexpected Docker answer');
  }
  const forContainer = isForContainer(body, container);
  if (forContainer === undefined) {
    return unknown('unexpected Docker answer');
  }
  if (!forContainer) {
    return { detail: 'no such container', state: 'stopped' };
  }
  const { ExitCode: exitCode, Running: running, Status: rawStatus } = body.State;
  const status = typeof rawStatus === 'string' ? rawStatus : undefined;
  const stopFacts = containerStopFacts(body, body.State, status);
  const withFacts = (outcome: ContainerOutcome): ContainerOutcome =>
    stopFacts === undefined ? outcome : { ...outcome, stopFacts };
  if (running && status !== 'paused' && status !== 'restarting') {
    return withFacts({ detail: `status ${status ?? 'running'}`, state: 'up' });
  }
  const code =
    typeof exitCode === 'number' && (status === 'exited' || status === 'dead')
      ? `, exit code ${String(exitCode)}`
      : '';
  return withFacts({ detail: `status ${status ?? 'not running'}${code}`, state: 'stopped' });
};

// What a GET that got no answer says. A refused or missing socket, a reset,
// and a timeout leave the container unknown, as does a failure on the
// Collector's own side.
const failureOutcome = ({
  message,
  reason,
}: Extract<HttpGetResult, { kind: 'failed' }>): ContainerOutcome => {
  switch (reason) {
    case 'timeout': {
      return unknown('Docker timed out');
    }
    case 'refused': {
      return unknown('Docker socket unreachable');
    }
    case 'reset': {
      return unknown('Docker connection reset');
    }
    case 'invalid response': {
      return unknown('unexpected Docker answer');
    }
    case 'error': {
      return unknown(`could not request Docker: ${message}`);
    }
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
};

// Asks the Engine, over its unix socket and with no docker CLI, whether a
// container is running. `get` uses no proxy and follows no redirect, and reads
// at most a cap of the answer. Only an answer that says no such container is
// stopped, and only the 200 for the container asked for is read as its state.
// Anything that keeps the Engine from answering for the container, such as a
// missing or refused socket, a timeout, a redirect or other status, an answer
// over the size cap, or a body that is not an inspect result, is unknown.
export const checkContainer = async (
  container: string,
  { endpoint, get, timeoutMs = DOCKER_TIMEOUT_MS }: DockerTools & { get: HttpGet },
): Promise<ContainerOutcome> => {
  if (endpoint.kind === 'unsupported') {
    return unknown('DOCKER_HOST is not a unix socket');
  }
  // Defense in depth: the record schema already refuses these. A URL parser
  // reads `.` and `..` as path segments, even encoded, so a stored record that
  // predates the schema would otherwise ask for another endpoint.
  if (/^\.{1,2}$/u.test(container)) {
    return unknown('not a container name');
  }
  // One byte past the cap tells a body that fits from one that was cut off.
  const result = await get(
    { path: `/containers/${encodeURIComponent(container)}/json`, socketPath: endpoint.path },
    { maxBodyBytes: MAX_ANSWER_BYTES + 1, timeoutMs },
  );
  if (result.kind === 'failed') {
    return failureOutcome(result);
  }
  if (result.status !== 200 && result.status !== 404) {
    return unknown(`Docker answered ${String(result.status)}`);
  }
  if (result.truncated) {
    return unknown('Docker answer too large');
  }
  if (result.status === 404) {
    return saysNoSuchContainer(result.body)
      ? { detail: 'no such container', state: 'stopped' }
      : unknown('Docker answered 404');
  }
  const body = parseJson(result.body);
  return body === undefined
    ? unknown('unexpected Docker answer')
    : containerOutcome(body, container);
};
