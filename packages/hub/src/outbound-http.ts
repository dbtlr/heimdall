// The Hub's own requests to other servers: the upstream checks (ADR-0022) and
// the price fetch (ADR-0024). Both follow redirects by hand, so each can
// refuse an address before it is contacted, and both cap how much of an
// answer they read.

export type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

// The statuses that redirect a request. 300 and 304 carry no address to follow.
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Whether `url` carries a user name or password, which `fetch` would send as
// credentials.
export const hasCredentials = (url: URL) => url.username !== '' || url.password !== '';

// The body read as text, or `over` when it ran past the cap.
export type CappedBody = { kind: 'over' } | { kind: 'read'; text: string };

// Reads the body of `response` as text, and stops and cancels it once it
// passes `maxBytes`, so no server can fill memory.
export const readCapped = async (response: Response, maxBytes: number): Promise<CappedBody> => {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream reads in order.
    const chunk = await reader?.read();
    if (chunk === undefined || chunk.done) {
      break;
    }
    length += chunk.value.byteLength;
    if (length > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- the read ends here.
      await reader?.cancel();
      return { kind: 'over' };
    }
    chunks.push(chunk.value);
  }
  return { kind: 'read', text: new TextDecoder().decode(Buffer.concat(chunks)) };
};

// The answer at the end of the redirects, with the address that gave it; or
// the address a redirect led to that `allowed` refused, never contacted; or
// `too-many` when the redirects went on past the limit.
export type Followed =
  | { kind: 'answered'; response: Response; url: URL }
  | { kind: 'refused'; from: URL | undefined; url: URL }
  | { kind: 'too-many' };

// Requests `start`, and follows each redirect by hand, at most `maxRedirects`
// times. `allowed` judges each address before it is contacted, `start`
// included, given the address that redirected to it; an address that carries
// credentials is always refused, so none is sent. `init` gives each
// request's options, so a header can go to one origin only. A request that
// fails throws as `fetch` does.
export const followRedirects = async ({
  allowed,
  fetch,
  init,
  maxRedirects,
  start,
}: {
  allowed: (url: URL, from: URL | undefined) => boolean;
  fetch: Fetch;
  init: (url: URL) => RequestInit;
  maxRedirects: number;
  start: URL;
}): Promise<Followed> => {
  let url = start;
  let from: URL | undefined;
  for (let hops = 0; ; hops += 1) {
    if (hasCredentials(url) || !allowed(url, from)) {
      return { from, kind: 'refused', url };
    }
    // oxlint-disable-next-line no-await-in-loop -- each hop needs the last one's answer.
    const response = await fetch(url, { ...init(url), redirect: 'manual' });
    const location = response.headers.get('location');
    if (!REDIRECTS.has(response.status) || location === null) {
      return { kind: 'answered', response, url };
    }
    // oxlint-disable-next-line no-await-in-loop -- the hop's body is unused.
    await response.body?.cancel();
    if (hops >= maxRedirects) {
      return { kind: 'too-many' };
    }
    from = url;
    url = new URL(location, url);
  }
};
