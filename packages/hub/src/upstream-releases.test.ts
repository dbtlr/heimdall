import { expect, test } from 'bun:test';

import { checkedUpstream, listReleases } from './upstream-releases.ts';
import type { Fetch } from './upstream-releases.ts';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

type Sent = { authorization: string | null; headers: Headers; url: string };

// A stand-in for the network: answers each URL from `routes`, records every
// request, and fails a URL it has no answer for.
const stubFetch = (routes: Record<string, (request: Request) => Response | Promise<Response>>) => {
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init) => {
    const request = new Request(url.href, init);
    sent.push({
      authorization: request.headers.get('authorization'),
      headers: request.headers,
      url: request.url,
    });
    const route = routes[request.url];
    if (route === undefined) {
      throw new Error(`Unexpected request to ${request.url}`);
    }
    return route(request);
  };
  return { fetch, sent };
};

const list = (upstream: string, fetch: Fetch) => listReleases(upstream, { fetch, now: () => NOW });

test.each([
  ['github:caddyserver/caddy', true],
  ['npm:@anthropic-ai/claude-code', true],
  ['oci:docker.io/library/nginx', true],
  ['apt:nginx', false],
  ['https://example.com/x', false],
])('%s is checked by the Hub: %p', (upstream, checked) => {
  expect(checkedUpstream(upstream)).toBe(checked);
});

test('a GitHub upstream lists the tags of its published releases, without credentials', async () => {
  const { fetch, sent } = stubFetch({
    'https://api.github.com/repos/caddyserver/caddy/releases?per_page=100': () =>
      Response.json([
        { draft: false, prerelease: false, tag_name: 'v2.8.4' },
        { draft: true, prerelease: false, tag_name: 'v2.9.0' },
        { draft: false, prerelease: true, tag_name: 'v2.9.0-beta.1' },
      ]),
  });

  expect(await list('github:caddyserver/caddy', fetch)).toEqual({
    kind: 'listed',
    releases: ['v2.8.4', 'v2.9.0-beta.1'],
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.authorization).toBeNull();
  expect(sent[0]?.headers.get('accept')).toBe('application/vnd.github+json');
  expect(sent[0]?.headers.get('user-agent')).toStartWith('heimdall-hub/');
});

test('GitHub out of requests defers to the reset time it gives', async () => {
  const reset = NOW / 1000 + 1800;
  const { fetch } = stubFetch({
    'https://api.github.com/repos/o/r/releases?per_page=100': () =>
      new Response('{}', {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        status: 403,
      }),
  });

  expect(await list('github:o/r', fetch)).toEqual({
    kind: 'limited',
    reason: 'api.github.com is rate-limiting the Hub.',
    retryAt: reset * 1000,
  });
});

test('a 429 defers by its Retry-After seconds', async () => {
  const { fetch } = stubFetch({
    'https://registry.npmjs.org/left-pad': () =>
      new Response('', { headers: { 'retry-after': '120' }, status: 429 }),
  });

  expect(await list('npm:left-pad', fetch)).toEqual({
    kind: 'limited',
    reason: 'registry.npmjs.org is rate-limiting the Hub.',
    retryAt: NOW + 120_000,
  });
});

test('an answer other than 2xx fails with its status alone', async () => {
  const { fetch } = stubFetch({
    'https://api.github.com/repos/o/gone/releases?per_page=100': () =>
      new Response('secret body', { status: 404 }),
  });

  expect(await list('github:o/gone', fetch)).toEqual({
    kind: 'failed',
    reason: 'api.github.com answered 404.',
  });
});

const unreachable: Fetch = () => Promise.reject(new Error('The operation timed out.'));

test('a request that cannot be made fails with why', async () => {
  expect(await list('npm:left-pad', unreachable)).toEqual({
    kind: 'failed',
    reason: 'Could not reach registry.npmjs.org: The operation timed out.',
  });
});

test('an answer of the wrong shape fails', async () => {
  const { fetch } = stubFetch({
    'https://api.github.com/repos/o/r/releases?per_page=100': () => Response.json({ x: 1 }),
  });

  expect(await list('github:o/r', fetch)).toEqual({
    kind: 'failed',
    reason: 'api.github.com answered with something other than a release list.',
  });
});

test('an npm upstream lists its versions, a scoped name encoded as one path segment', async () => {
  const { fetch, sent } = stubFetch({
    'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code': () =>
      Response.json({ name: '@anthropic-ai/claude-code', versions: { '2.0.1': {}, '2.1.0': {} } }),
  });

  expect(await list('npm:@anthropic-ai/claude-code', fetch)).toEqual({
    kind: 'listed',
    releases: ['2.0.1', '2.1.0'],
  });
  expect(sent[0]?.headers.get('accept')).toBe('application/vnd.npm.install-v1+json');
});

const challenge = (realm: string) =>
  new Response('', {
    headers: {
      'www-authenticate': `Bearer realm="${realm}",service="registry.docker.io",scope="repository:library/nginx:pull"`,
    },
    status: 401,
  });

test('an OCI upstream answers the anonymous token challenge and follows each page of tags', async () => {
  const tags = 'https://registry-1.docker.io/v2/library/nginx/tags/list';
  const { fetch, sent } = stubFetch({
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull':
      () => Response.json({ token: 't0k' }),
    [tags]: (request) =>
      request.headers.get('authorization') === 'Bearer t0k'
        ? Response.json(
            { name: 'library/nginx', tags: ['1.26', '1.27-alpine'] },
            { headers: { link: '</v2/library/nginx/tags/list?last=1.27-alpine>; rel="next"' } },
          )
        : challenge('https://auth.docker.io/token'),
    [`${tags}?last=1.27-alpine`]: () => Response.json({ name: 'library/nginx', tags: ['latest'] }),
  });

  expect(await list('oci:docker.io/library/nginx', fetch)).toEqual({
    kind: 'listed',
    releases: ['1.26', '1.27-alpine', 'latest'],
  });
  expect(sent.map(({ authorization, url }) => [url, authorization])).toEqual([
    [tags, null],
    [
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull',
      null,
    ],
    [tags, 'Bearer t0k'],
    [`${tags}?last=1.27-alpine`, 'Bearer t0k'],
  ]);
});

test('a registry that needs no token lists its tags directly', async () => {
  const { fetch } = stubFetch({
    'https://registry.example:5000/v2/team/app/tags/list': () =>
      Response.json({ name: 'team/app', tags: ['1.0.0'] }),
  });

  expect(await list('oci:registry.example:5000/team/app', fetch)).toEqual({
    kind: 'listed',
    releases: ['1.0.0'],
  });
});

test('a token challenge whose realm is not HTTPS is refused before it is contacted', async () => {
  const { fetch, sent } = stubFetch({
    'https://ghcr.io/v2/o/app/tags/list': () => challenge('http://ghcr.io/token'),
  });

  expect(await list('oci:ghcr.io/o/app', fetch)).toEqual({
    kind: 'failed',
    reason: 'ghcr.io asked for a token from somewhere other than an HTTPS address.',
  });
  expect(sent).toHaveLength(1);
});

test('a redirect to plain HTTP is refused, and one to HTTPS is followed', async () => {
  const { fetch, sent } = stubFetch({
    'https://api.github.com/repos/o/insecure/releases?per_page=100': () =>
      Response.redirect('http://api.github.com/repositories/43/releases?per_page=100', 301),
    'https://api.github.com/repos/old/name/releases?per_page=100': () =>
      Response.redirect('https://api.github.com/repositories/42/releases?per_page=100', 301),
    'https://api.github.com/repositories/42/releases?per_page=100': () =>
      Response.json([{ draft: false, prerelease: false, tag_name: '1.0' }]),
  });

  expect(await list('github:old/name', fetch)).toEqual({ kind: 'listed', releases: ['1.0'] });
  expect(await list('github:o/insecure', fetch)).toEqual({
    kind: 'failed',
    reason: 'api.github.com redirected the Hub to an address that is not HTTPS.',
  });
  expect(sent.map(({ url }) => url)).not.toContain(
    'http://api.github.com/repositories/43/releases?per_page=100',
  );
});

test('a token is not sent on to another host a registry redirects to', async () => {
  const { fetch, sent } = stubFetch({
    'https://auth.example/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull':
      () => Response.json({ access_token: 't0k' }),
    'https://cdn.example/tags': () => Response.json({ name: 'o/app', tags: ['2.0'] }),
    'https://registry.example/v2/o/app/tags/list': (request) =>
      request.headers.get('authorization') === null
        ? challenge('https://auth.example/token')
        : Response.redirect('https://cdn.example/tags', 307),
  });

  expect(await list('oci:registry.example/o/app', fetch)).toEqual({
    kind: 'listed',
    releases: ['2.0'],
  });
  expect(sent.at(-1)).toMatchObject({ authorization: null, url: 'https://cdn.example/tags' });
});

test('a tag list longer than the page limit fails rather than leaving tags out', async () => {
  const { fetch } = stubFetch({
    'https://registry.example/v2/o/app/tags/list': () =>
      Response.json(
        { name: 'o/app', tags: ['1.0'] },
        { headers: { link: '</v2/o/app/tags/list>; rel="next"' } },
      ),
  });

  expect(await list('oci:registry.example/o/app', fetch)).toEqual({
    kind: 'failed',
    reason: 'registry.example has more pages of tags than the Hub reads.',
  });
});

test('an answer larger than the Hub reads fails', async () => {
  const { fetch } = stubFetch({
    'https://registry.npmjs.org/huge': () =>
      new Response(new Uint8Array(33 * 1024 * 1024), {
        headers: { 'content-type': 'application/json' },
      }),
  });

  expect(await list('npm:huge', fetch)).toEqual({
    kind: 'failed',
    reason: 'registry.npmjs.org answered with more than the Hub reads.',
  });
});

test.each([
  'github:owner',
  'github:../etc/passwd',
  'github:o/r/extra',
  'npm:',
  'npm:../x',
  'npm:@scope',
  'oci:nginx',
  'oci:registry.example/../x',
  'oci:registry.example/o/App',
  'oci:user@registry.example/o/app',
])('%s fails as not a valid upstream without any request', async (upstream) => {
  const { fetch, sent } = stubFetch({});

  expect(await list(upstream, fetch)).toEqual({
    kind: 'failed',
    reason: `${upstream} is not a valid upstream.`,
  });
  expect(sent).toEqual([]);
});

test('a Retry-After date defers to that time, read from a 403 as from a 429', async () => {
  const { fetch } = stubFetch({
    'https://api.github.com/repos/o/r/releases?per_page=100': () =>
      new Response('', {
        headers: { 'retry-after': 'Tue, 27 Oct 2026 13:30:00 GMT' },
        status: 403,
      }),
  });

  expect(await list('github:o/r', fetch)).toEqual({
    kind: 'limited',
    reason: 'api.github.com is rate-limiting the Hub.',
    retryAt: Date.UTC(2026, 9, 27, 13, 30, 0),
  });
});

test('Retry-After seconds count from when the answer arrives', async () => {
  let clock = NOW;
  const fetch: Fetch = () => {
    clock += 120_000;
    return Promise.resolve(new Response('', { headers: { 'retry-after': '60' }, status: 429 }));
  };

  expect(await listReleases('npm:left-pad', { fetch, now: () => clock })).toEqual({
    kind: 'limited',
    reason: 'registry.npmjs.org is rate-limiting the Hub.',
    retryAt: NOW + 180_000,
  });
});

test('a redirect loop fails after a few hops', async () => {
  const url = 'https://api.github.com/repos/o/loop/releases?per_page=100';
  const { fetch, sent } = stubFetch({ [url]: () => Response.redirect(url, 302) });

  expect(await list('github:o/loop', fetch)).toEqual({
    kind: 'failed',
    reason: 'api.github.com redirected the Hub too many times.',
  });
  expect(sent).toHaveLength(6);
});

test('a stop aborts the request in flight', async () => {
  const stop = new AbortController();
  const signals: AbortSignal[] = [];
  const fetch: Fetch = (_, init) => {
    if (init.signal !== null && init.signal !== undefined) {
      signals.push(init.signal);
    }
    stop.abort();
    return Promise.reject(new Error('This operation was aborted.'));
  };

  await listReleases('npm:left-pad', { fetch, now: () => NOW, signal: stop.signal });

  expect(signals.map(({ aborted }) => aborted)).toEqual([true]);
});

test('an answer streamed in small pieces is capped by its total size', async () => {
  const piece = new Uint8Array(1024 * 1024);
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
    pull: (controller) => {
      sent += 1;
      controller.enqueue(piece);
    },
  });
  const { fetch } = stubFetch({ 'https://registry.npmjs.org/huge': () => new Response(body) });

  expect(await list('npm:huge', fetch)).toEqual({
    kind: 'failed',
    reason: 'registry.npmjs.org answered with more than the Hub reads.',
  });
  expect(sent).toBeLessThan(40);
  expect(cancelled).toBe(true);
});

test('a registry that redirects before it challenges gets the token, and the first host does not', async () => {
  const { fetch, sent } = stubFetch({
    'https://auth.example/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull':
      () => Response.json({ token: 't0k' }),
    'https://mirror.example/v2/o/app/tags/list': (request) =>
      request.headers.get('authorization') === 'Bearer t0k'
        ? Response.json({ name: 'o/app', tags: ['3.0'] })
        : challenge('https://auth.example/token'),
    'https://registry.example/v2/o/app/tags/list': () =>
      Response.redirect('https://mirror.example/v2/o/app/tags/list', 307),
  });

  expect(await list('oci:registry.example/o/app', fetch)).toEqual({
    kind: 'listed',
    releases: ['3.0'],
  });
  expect(sent.map(({ authorization, url }) => [url, authorization])).toEqual([
    ['https://registry.example/v2/o/app/tags/list', null],
    ['https://mirror.example/v2/o/app/tags/list', null],
    [
      'https://auth.example/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull',
      null,
    ],
    ['https://mirror.example/v2/o/app/tags/list', 'Bearer t0k'],
  ]);
});

test.each([
  'Basic realm="registry", Bearer realm="https://auth.example/token",service="svc"',
  'Bearer realm="https://auth.example/token",service="svc", Basic realm="registry"',
  'Bearer realm=https://auth.example/token, service=svc',
])('the Bearer challenge is read among others: %s', async (header) => {
  const { fetch } = stubFetch({
    'https://auth.example/token?service=svc&scope=repository%3Ao%2Fapp%3Apull': () =>
      Response.json({ token: 't0k' }),
    'https://registry.example/v2/o/app/tags/list': (request) =>
      request.headers.get('authorization') === 'Bearer t0k'
        ? Response.json({ name: 'o/app', tags: ['1.0'] })
        : new Response('', { headers: { 'www-authenticate': header }, status: 401 }),
  });

  expect(await list('oci:registry.example/o/app', fetch)).toEqual({
    kind: 'listed',
    releases: ['1.0'],
  });
});

test('a registry that lists more tags than the Hub reads fails', async () => {
  const { fetch } = stubFetch({
    'https://registry.example/v2/o/app/tags/list': () =>
      Response.json({
        name: 'o/app',
        tags: Array.from({ length: 100_001 }, (_, i) => `1.0.${String(i)}`),
      }),
  });

  expect(await list('oci:registry.example/o/app', fetch)).toEqual({
    kind: 'failed',
    reason: 'registry.example lists more tags than the Hub reads.',
  });
});
