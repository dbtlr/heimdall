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

// A container's state from the Engine's `GET /containers/<id>/json` body. The
// Engine says Running for a paused container and for one between restarts, so
// the status decides those; Docker's own healthcheck is not read, since the
// health URL covers health. The exit code is only meaningful once a container
// has run and stopped.
const containerOutcome = (body: unknown): ContainerOutcome => {
  const state: unknown =
    typeof body === 'object' && body !== null && 'State' in body ? body.State : undefined;
  if (typeof state !== 'object' || state === null || !('Running' in state)) {
    return unknown('unexpected Docker answer');
  }
  const { Running: running } = state;
  if (typeof running !== 'boolean') {
    return unknown('unexpected Docker answer');
  }
  const status = 'Status' in state && typeof state.Status === 'string' ? state.Status : undefined;
  if (running && status !== 'paused' && status !== 'restarting') {
    return { detail: `status ${status ?? 'running'}`, state: 'up' };
  }
  const exitCode =
    'ExitCode' in state &&
    typeof state.ExitCode === 'number' &&
    (status === 'exited' || status === 'dead')
      ? `, exit code ${String(state.ExitCode)}`
      : '';
  return { detail: `status ${status ?? 'not running'}${exitCode}`, state: 'stopped' };
};

// Asks the Engine, over its unix socket and with no docker CLI, whether a
// container is running. A container the Engine does not know (404) is stopped.
// Anything that keeps the Engine from answering for the container, such as a
// missing or refused socket, a timeout, another status, or a body that is not an
// inspect result, is unknown.
export const checkContainer = async (
  container: string,
  { endpoint, timeoutMs = DOCKER_TIMEOUT_MS }: DockerTools,
): Promise<ContainerOutcome> => {
  if (endpoint.kind === 'unsupported') {
    return unknown('DOCKER_HOST is not a unix socket');
  }
  // A URL parser reads `.` and `..` as path segments, even encoded.
  if (/^\.{1,2}$/u.test(container)) {
    return unknown('not a container name');
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(
      `http://localhost/containers/${encodeURIComponent(container)}/json`,
      {
        method: 'GET',
        signal,
        unix: endpoint.path,
      },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return { detail: 'no such container', state: 'stopped' };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return unknown(`Docker answered ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      return unknown('unexpected Docker answer');
    }
    return containerOutcome(body);
  } catch {
    return unknown(signal.aborted ? 'Docker timed out' : 'Docker socket unreachable');
  }
};
