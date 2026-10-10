import type { ServiceCheckState } from '@heimdall/schema';

// What one container check found, before the supervisor check clamps the detail.
export type ContainerOutcome = { detail: string; state: ServiceCheckState };

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

// The answer's text, or undefined when it is larger than the cap. A larger
// Content-Length is refused unread, and a stream is read only up to the cap,
// so an endless body costs a bounded read.
const readCapped = async (response: Response): Promise<string | undefined> => {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_ANSWER_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each chunk follows the last.
    const { done, value } = await reader.read();
    if (done) {
      return new TextDecoder().decode(Buffer.concat(chunks));
    }
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      break;
    }
    chunks.push(value);
  }
  await reader.cancel();
  return undefined;
};

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

// A container's state from the Engine's `GET /containers/<id>/json` body. The
// Engine says Running for a paused container and for one between restarts, so
// the status decides those; Docker's own healthcheck is not read, since the
// health URL covers health. The exit code is only meaningful once a container
// has run and stopped.
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
  if (running && status !== 'paused' && status !== 'restarting') {
    return { detail: `status ${status ?? 'running'}`, state: 'up' };
  }
  const code =
    typeof exitCode === 'number' && (status === 'exited' || status === 'dead')
      ? `, exit code ${String(exitCode)}`
      : '';
  return { detail: `status ${status ?? 'not running'}${code}`, state: 'stopped' };
};

// Asks the Engine, over its unix socket and with no docker CLI, whether a
// container is running. Only an answer that says no such container is
// stopped, and only the 200 for the container asked for is read as its state.
// Anything that keeps the Engine from answering for the container, such as a
// missing or refused socket, a timeout, a redirect or other status, an answer
// over the size cap, or a body that is not an inspect result, is unknown.
export const checkContainer = async (
  container: string,
  { endpoint, timeoutMs = DOCKER_TIMEOUT_MS }: DockerTools,
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
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // A redirect is never followed: the Engine does not send one, and the
    // Location of another listener is not the Engine.
    const response = await fetch(
      `http://localhost/containers/${encodeURIComponent(container)}/json`,
      { method: 'GET', redirect: 'manual', signal, unix: endpoint.path },
    );
    if (response.status !== 200 && response.status !== 404) {
      await response.body?.cancel();
      return unknown(`Docker answered ${String(response.status)}`);
    }
    const text = await readCapped(response);
    if (text === undefined) {
      return unknown('Docker answer too large');
    }
    if (response.status === 404) {
      return saysNoSuchContainer(text)
        ? { detail: 'no such container', state: 'stopped' }
        : unknown('Docker answered 404');
    }
    const body = parseJson(text);
    return body === undefined
      ? unknown('unexpected Docker answer')
      : containerOutcome(body, container);
  } catch {
    return unknown(signal.aborted ? 'Docker timed out' : 'Docker socket unreachable');
  }
};
