import { request } from 'node:http';

// Where to send the GET: a TCP address or a unix socket.
export type HttpTarget =
  | { host: string; path: string; port: number }
  | { path: string; socketPath: string };

// Why a GET got no answer. `error` is a failure on this side that says nothing
// about the other, such as running out of file descriptors.
export type HttpFailure = 'error' | 'invalid response' | 'refused' | 'reset' | 'timeout';

// What a GET came to: an answer, with the status and as much of the body as the
// cap allowed (`truncated` when there was, or may have been, more), or the
// reason there was none.
export type HttpGetResult =
  | { body: string; kind: 'response'; status: number; truncated: boolean }
  | { kind: 'failed'; message: string; reason: HttpFailure };

export type HttpGetOptions = {
  // The most bytes of the body to read. The connection is closed once they are
  // read; a cap of 0 reads none.
  maxBodyBytes: number;
  // How long the whole GET may take, body included.
  timeoutMs: number;
};

export type HttpGet = (target: HttpTarget, options: HttpGetOptions) => Promise<HttpGetResult>;

// Errors that mean nothing is listening at the address. A unix socket that does
// not exist is the same as one nothing listens on.
const REFUSED = new Set(['ECONNREFUSED', 'ENOENT']);
const RESET = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET']);

// The TCP target of an `http://` URL, such as `http://[::1]:8080/healthz?x=1`.
export const tcpTargetOf = (url: string): Extract<HttpTarget, { host: string }> => {
  const { hostname, pathname, port, search } = new URL(url);
  return {
    host: hostname.startsWith('[') ? hostname.slice(1, -1) : hostname,
    path: `${pathname}${search}`,
    port: port === '' ? 80 : Number(port),
  };
};

const failureOf = (error: unknown): { message: string; reason: HttpFailure } => {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  if (REFUSED.has(code)) {
    return { message, reason: 'refused' };
  }
  if (RESET.has(code)) {
    return { message, reason: 'reset' };
  }
  // Node's HTTP parser names a malformed answer HPE_*.
  return { message, reason: code.startsWith('HPE_') ? 'invalid response' : 'error' };
};

// GETs `target` with `node:http`. Unlike `fetch`, that never reads a proxy from
// the environment, so a request to loopback or a local socket cannot be sent
// elsewhere, and it never follows a redirect: a 3xx is the answer. It reads the
// body only up to `maxBodyBytes`, and closes the connection when it has the
// answer, on timeout, or on failure. It never rejects.
export const httpGet: HttpGet = (target, { maxBodyBytes, timeoutMs }) =>
  // oxlint-disable-next-line promise/avoid-new -- adapts node:http's events to a promise.
  new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let call: ReturnType<typeof request> | undefined = undefined;
    const finish = (result: HttpGetResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        call?.destroy();
        resolve(result);
      }
    };
    const fail = (error: unknown) => finish({ kind: 'failed', ...failureOf(error) });

    timer = setTimeout(() => {
      finish({
        kind: 'failed',
        message: `no answer in ${String(timeoutMs)} ms`,
        reason: 'timeout',
      });
    }, timeoutMs);

    try {
      call = request({ ...target, agent: false, method: 'GET' }, (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        const answer = (truncated: boolean) =>
          finish({
            body: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBodyBytes)),
            kind: 'response',
            status,
            truncated,
          });
        if (maxBodyBytes === 0) {
          answer(true);
          return;
        }
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxBodyBytes) {
            answer(true);
          }
        });
        response.on('end', () => answer(false));
        response.on('error', fail);
        response.on('close', () => {
          // The connection closed before the body ended.
          finish({ kind: 'failed', message: 'connection closed mid-body', reason: 'reset' });
        });
      });
      call.on('error', fail);
      call.on('upgrade', () => {
        finish({
          kind: 'failed',
          message: 'the server switched protocols',
          reason: 'invalid response',
        });
      });
      call.end();
    } catch (error) {
      fail(error);
    }
  });
