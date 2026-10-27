import { z } from 'zod';

import { describeError } from './errors.ts';
import { HUB_VERSION } from './version.ts';

export type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

// What one check of an upstream found: every release it lists, or why it
// could not tell. A rate-limited answer says when the upstream allows asking
// again, when it says.
export type CheckAnswer =
  | { kind: 'listed'; releases: string[] }
  | { kind: 'failed'; reason: string }
  | { kind: 'limited'; reason: string; retryAt: number | null };

const REQUEST_TIMEOUT_MS = 30_000;
// npm's abbreviated metadata for its largest packages is a few MiB.
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TAG_PAGES = 50;
// Far more tags than any image publishes, so a registry cannot fill memory
// across pages.
const MAX_TAGS = 100_000;

const GITHUB = /^github:([\dA-Za-z-]{1,39})\/([\w.-]{1,100})$/u;
const NPM = /^npm:((?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*)$/u;
// A registry host, with an optional port, then a repository path as the OCI
// distribution spec names one.
const OCI =
  /^oci:([\da-z](?:[\da-z-]*[\da-z])?(?:\.[\da-z](?:[\da-z-]*[\da-z])?)*(?::\d{1,5})?)\/([\da-z]+(?:(?:[._]|__|-+)[\da-z]+)*(?:\/[\da-z]+(?:(?:[._]|__|-+)[\da-z]+)*)*)$/u;

// Whether the Hub asks this upstream for its releases (ADR-0022). APT and
// Homebrew upstreams come from the Collector's package observations instead.
export const checkedUpstream = (upstream: string) => /^(?:github|npm|oci):/u.test(upstream);

// Why a check found no releases, thrown from deep in a check and turned into
// its answer at the top. `limited` holds a rate limit's retry time, null when
// the upstream gave none; it is undefined for any other failure.
class CheckFailureError extends Error {
  readonly limited: { retryAt: number | null } | undefined;
  constructor(reason: string, limited?: { retryAt: number | null }) {
    super(reason);
    this.name = 'CheckFailureError';
    this.limited = limited;
  }
}

// When a rate-limited answer allows the next request, from Retry-After as
// seconds or a date, or GitHub's reset time in epoch seconds.
const retryTime = (response: Response, now: number) => {
  const after = response.headers.get('retry-after');
  if (after !== null) {
    const seconds = Number(after);
    const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(after);
    return Number.isNaN(at) ? null : at;
  }
  const reset = Number(response.headers.get('x-ratelimit-reset') ?? Number.NaN);
  return Number.isFinite(reset) ? reset * 1000 : null;
};

const rateLimited = (response: Response) =>
  response.status === 429 ||
  (response.status === 403 &&
    (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));

// Reads at most MAX_ANSWER_BYTES of the body, so no upstream can fill memory.
const readCapped = async (response: Response, host: string) => {
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
    if (length > MAX_ANSWER_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- the read ends here.
      await reader?.cancel();
      throw new CheckFailureError(`${host} answered with more than the Hub reads.`);
    }
    chunks.push(chunk.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

type Answer = { body: string; response: Response; url: URL };
// How a check makes its requests. `now` reads a Retry-After given in seconds
// when the answer arrives, and `signal` ends a request early when serve stops.
export type Requester = { fetch: Fetch; now: () => number; signal?: AbortSignal };

// A GET over HTTPS only, following redirects by hand so none leaves HTTPS, and
// sending `authorization` only to its own origin. `host` names the upstream
// in a failure. A 401 is returned for the caller to answer; any other answer
// outside 2xx throws with its status alone, never its body.
const get = async (
  start: URL,
  {
    accept,
    authorization,
    host,
    request: { fetch, now, signal },
  }: {
    accept: string;
    authorization?: { origin: string; value: string } | undefined;
    host: string;
    request: Requester;
  },
): Promise<Answer> => {
  let url = start;
  for (let hops = 0; ; hops += 1) {
    if (url.protocol !== 'https:') {
      throw new CheckFailureError(`${host} redirected the Hub to an address that is not HTTPS.`);
    }
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': `heimdall-hub/${HUB_VERSION}`,
    };
    if (authorization !== undefined && authorization.origin === url.origin) {
      headers.Authorization = authorization.value;
    }
    let response: Response;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each hop needs the last one's answer.
      response = await fetch(url, {
        headers,
        redirect: 'manual',
        signal:
          signal === undefined
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]),
      });
    } catch (error) {
      throw new CheckFailureError(`Could not reach ${host}: ${describeError(error)}`);
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      // oxlint-disable-next-line no-await-in-loop -- the hop's body is unused.
      await response.body?.cancel();
      if (hops >= MAX_REDIRECTS) {
        throw new CheckFailureError(`${host} redirected the Hub too many times.`);
      }
      url = new URL(location, url);
      continue;
    }
    if (rateLimited(response)) {
      // oxlint-disable-next-line no-await-in-loop -- the body is unused.
      await response.body?.cancel();
      throw new CheckFailureError(`${host} is rate-limiting the Hub.`, {
        retryAt: retryTime(response, now()),
      });
    }
    if (response.status === 401) {
      // oxlint-disable-next-line no-await-in-loop -- the body is unused.
      await response.body?.cancel();
      return { body: '', response, url };
    }
    if (!response.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the body is unused.
      await response.body?.cancel();
      throw new CheckFailureError(`${host} answered ${String(response.status)}.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- the last hop's body is the answer.
    return { body: await readCapped(response, host), response, url };
  }
};

const parseJson = <T>(answer: Answer, schema: z.ZodType<T>, host: string, what: string): T => {
  let value: unknown;
  try {
    value = JSON.parse(answer.body);
  } catch {
    value = undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CheckFailureError(`${host} answered with something other than ${what}.`);
  }
  return parsed.data;
};

const unauthorized = (answer: Answer, host: string) => {
  if (answer.response.status === 401) {
    throw new CheckFailureError(`${host} answered 401.`);
  }
  return answer;
};

const GitHubReleasesSchema = z.array(z.object({ draft: z.boolean(), tag_name: z.string() }));

// The newest hundred releases GitHub lists, drafts aside. Unauthenticated, a
// draft is never listed; the filter keeps that true if a token is ever sent.
const githubReleases = async (owner: string, repo: string, request: Requester) => {
  const host = 'api.github.com';
  const answer = await get(
    new URL(`https://${host}/repos/${owner}/${repo}/releases?per_page=100`),
    { accept: 'application/vnd.github+json', host, request },
  );
  const releases = parseJson(
    unauthorized(answer, host),
    GitHubReleasesSchema,
    host,
    'a release list',
  );
  return releases.filter(({ draft }) => !draft).map(({ tag_name: tag }) => tag);
};

const NpmPackageSchema = z.object({ versions: z.record(z.string(), z.unknown()) });

// Every version the registry lists, from its abbreviated metadata. An
// unpublished version is no longer listed.
const npmVersions = async (name: string, request: Requester) => {
  const host = 'registry.npmjs.org';
  const answer = await get(new URL(`https://${host}/${name.replace('/', '%2F')}`), {
    accept: 'application/vnd.npm.install-v1+json',
    host,
    request,
  });
  return Object.keys(
    parseJson(unauthorized(answer, host), NpmPackageSchema, host, 'a package').versions,
  );
};

const TagListSchema = z.object({ tags: z.array(z.string()).nullable() });
const TokenSchema = z.union([
  z.object({ token: z.string().min(1) }),
  z.object({ access_token: z.string().min(1) }),
]);

// The parameters of the `Bearer` challenge among a header's challenges, such
// as realm, service, and scope. Reading stops at the next challenge's scheme,
// so another challenge's realm is never taken for the Bearer one.
const bearerChallenge = (header: string | null) => {
  const scheme = header === null ? null : /(?:^|[\s,])bearer\s/iu.exec(header);
  if (header === null || scheme === null) {
    return undefined;
  }
  const params: Record<string, string> = {};
  const param = /\s*,?\s*(\w+)\s*=\s*(?:"([^"]*)"|([^\s",]*))/uy;
  param.lastIndex = scheme.index + scheme[0].length;
  for (let match = param.exec(header); match !== null; match = param.exec(header)) {
    const key = (match[1] ?? '').toLowerCase();
    params[key] ??= match[2] ?? match[3] ?? '';
  }
  return params;
};

// An anonymous pull token, as the registry's challenge asks for one.
const anonymousToken = async (
  challenged: Answer,
  repository: string,
  { host, request }: { host: string; request: Requester },
) => {
  const challenge = bearerChallenge(challenged.response.headers.get('www-authenticate'));
  if (challenge?.realm === undefined) {
    throw new CheckFailureError(`${host} answered 401.`);
  }
  const realm = URL.parse(challenge.realm);
  if (realm?.protocol !== 'https:') {
    throw new CheckFailureError(
      `${host} asked for a token from somewhere other than an HTTPS address.`,
    );
  }
  if (challenge.service !== undefined) {
    realm.searchParams.set('service', challenge.service);
  }
  realm.searchParams.set('scope', challenge.scope ?? `repository:${repository}:pull`);
  const answer = await get(realm, { accept: 'application/json', host, request });
  const parsed = parseJson(unauthorized(answer, host), TokenSchema, host, 'a token');
  return 'token' in parsed ? parsed.token : parsed.access_token;
};

// The URL a `Link` header's `rel="next"` names, resolved against `base`.
const nextPage = (link: string | null, base: URL) => {
  const next = link?.split(',').find((part) => /;\s*rel="?next"?/u.test(part));
  const target = next?.match(/<([^>]*)>/u)?.[1];
  return target === undefined ? undefined : new URL(target, base);
};

// Every tag the registry lists, page by page, after its anonymous token
// challenge when it asks. Docker Hub's API lives on its own host.
const ociTags = async (registry: string, repository: string, request: Requester) => {
  const host = registry;
  const api = registry === 'docker.io' ? 'registry-1.docker.io' : registry;
  let url: URL | undefined = new URL(`https://${api}/v2/${repository}/tags/list`);
  let authorization: { origin: string; value: string } | undefined;
  const tags: string[] = [];
  for (let page = 0; url !== undefined; page += 1) {
    if (page >= MAX_TAG_PAGES) {
      throw new CheckFailureError(`${host} has more pages of tags than the Hub reads.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- each page names the next.
    let answer = await get(url, { accept: 'application/json', authorization, host, request });
    if (answer.response.status === 401 && authorization === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- the token gates every page.
      const token = await anonymousToken(answer, repository, { host, request });
      // The token is for the host that challenged, after any redirect.
      authorization = { origin: answer.url.origin, value: `Bearer ${token}` };
      // oxlint-disable-next-line no-await-in-loop -- the same page, now with the token.
      answer = await get(answer.url, {
        accept: 'application/json',
        authorization,
        host,
        request,
      });
    }
    const list = parseJson(unauthorized(answer, host), TagListSchema, host, 'a tag list');
    tags.push(...(list.tags ?? []));
    if (tags.length > MAX_TAGS) {
      throw new CheckFailureError(`${host} lists more tags than the Hub reads.`);
    }
    url = nextPage(answer.response.headers.get('link'), answer.url);
  }
  return tags;
};

const releasesOf = (upstream: string, request: Requester) => {
  const github = GITHUB.exec(upstream);
  if (github !== null && github[2] !== '.' && github[2] !== '..') {
    return githubReleases(github[1] ?? '', github[2] ?? '', request);
  }
  const npm = NPM.exec(upstream);
  if (npm !== null && npm[1] !== undefined && npm[1].length <= 214) {
    return npmVersions(npm[1], request);
  }
  const oci = OCI.exec(upstream);
  if (oci !== null) {
    return ociTags(oci[1] ?? '', oci[2] ?? '', request);
  }
  throw new CheckFailureError(`${upstream} is not a valid upstream.`);
};

// Asks a `github:`, `npm:`, or `oci:` upstream for every release it lists,
// over HTTPS and without credentials (ADR-0022). Never throws: a failure is
// an answer, so the caller keeps the last one it had.
export const listReleases = async (upstream: string, request: Requester): Promise<CheckAnswer> => {
  try {
    return { kind: 'listed', releases: await releasesOf(upstream, request) };
  } catch (error) {
    if (!(error instanceof CheckFailureError)) {
      return { kind: 'failed', reason: describeError(error) };
    }
    return error.limited === undefined
      ? { kind: 'failed', reason: error.message }
      : { kind: 'limited', reason: error.message, retryAt: error.limited.retryAt };
  }
};
