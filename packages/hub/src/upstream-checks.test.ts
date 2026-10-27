import { expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { NOW } from './testing/hub.ts';
import { migratedDatabase } from './testing/postgres.ts';
import { checkUpstreams, UPSTREAM_CHECK_INTERVAL_MS } from './upstream-checks.ts';
import type { CheckAnswer } from './upstream-releases.ts';

const HOUR = 3_600_000;

// A migrated database where `system` runs `service` at `upstream`, as
// HMD-177's version rows and the System's mirrored Service record say.
const runs = async (
  sql: SQL,
  {
    at = NOW - HOUR,
    forgotten = false,
    service,
    system = 'server-1',
    upstream,
  }: {
    at?: number;
    forgotten?: boolean;
    service: string;
    system?: string;
    upstream: string | null;
  },
) => {
  await sql`INSERT INTO systems (name) VALUES (${system}) ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO service_versions (system, service, version, upstream, first_seen_at)
    VALUES (${system}, ${service}, '1.0.0', ${upstream}, ${new Date(at)})
  `;
  if (!forgotten) {
    await sql`
      INSERT INTO mirrored_records (system, kind, name, record)
      VALUES (${system}, 'service', ${service}, ${{ name: service, supervisor: 'none' }}::jsonb)
      ON CONFLICT DO NOTHING
    `;
  }
};

const database = async () => {
  const db = await migratedDatabase();
  return db;
};

// Answers each upstream from `answers`, recording which were asked.
const lister = (answers: Record<string, CheckAnswer>) => {
  const asked: string[] = [];
  const list = (upstream: string) => {
    asked.push(upstream);
    const answer = answers[upstream];
    if (answer === undefined) {
      throw new Error(`Unexpected check of ${upstream}`);
    }
    return Promise.resolve(answer);
  };
  return { asked, list };
};

const listed = (...releases: string[]): CheckAnswer => ({ kind: 'listed', releases });

// Rows as plain objects, which toMatchObject compares field by field.
const checks = async (sql: SQL) =>
  (
    await sql`
      SELECT upstream, releases, checked_at, succeeded_at, failure, next_check_at
      FROM upstream_checks ORDER BY upstream
    `
  ).map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row)));

const releases = (sql: SQL) =>
  sql`
    SELECT upstream, version, first_found_at FROM upstream_releases ORDER BY upstream, version
  ` as Promise<Record<string, unknown>[]>;

test('a checked upstream keeps its newest release per channel and when each was first found', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'caddy', upstream: 'github:caddyserver/caddy' });
  const { list } = lister({
    'github:caddyserver/caddy': listed(
      'v2.8.4',
      'v2.7.0',
      'v2.9.0-beta.1',
      'v2.9.0-beta.2',
      'latest',
    ),
  });

  await checkUpstreams(db.sql, { list, now: () => NOW });

  expect(await checks(db.sql)).toEqual([
    {
      checked_at: new Date(NOW),
      failure: null,
      next_check_at: new Date(NOW + UPSTREAM_CHECK_INTERVAL_MS),
      releases: { '': 'v2.8.4', 'beta.#': 'v2.9.0-beta.2' },
      succeeded_at: new Date(NOW),
      upstream: 'github:caddyserver/caddy',
    },
  ]);
  expect(await releases(db.sql)).toEqual([
    { first_found_at: new Date(NOW), upstream: 'github:caddyserver/caddy', version: 'v2.8.4' },
    {
      first_found_at: new Date(NOW),
      upstream: 'github:caddyserver/caddy',
      version: 'v2.9.0-beta.2',
    },
  ]);
});

test('an upstream is asked again only once its next check is due', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'app', upstream: 'npm:app' });
  const first = lister({ 'npm:app': listed('1.0.0') });
  await checkUpstreams(db.sql, { list: first.list, now: () => NOW });

  const early = lister({});
  await checkUpstreams(db.sql, {
    list: early.list,
    now: () => NOW + UPSTREAM_CHECK_INTERVAL_MS - 1,
  });
  const due = lister({ 'npm:app': listed('1.0.0', '1.1.0') });
  await checkUpstreams(db.sql, { list: due.list, now: () => NOW + UPSTREAM_CHECK_INTERVAL_MS });

  expect(early.asked).toEqual([]);
  expect(due.asked).toEqual(['npm:app']);
  expect(await releases(db.sql)).toEqual([
    { first_found_at: new Date(NOW), upstream: 'npm:app', version: '1.0.0' },
    {
      first_found_at: new Date(NOW + UPSTREAM_CHECK_INTERVAL_MS),
      upstream: 'npm:app',
      version: '1.1.0',
    },
  ]);
});

test('a release the upstream withdraws stops counting, but when it was found stays', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'app', upstream: 'npm:app' });
  await checkUpstreams(db.sql, {
    list: lister({ 'npm:app': listed('1.0.0', '1.1.0') }).list,
    now: () => NOW,
  });

  const later = NOW + UPSTREAM_CHECK_INTERVAL_MS;
  await checkUpstreams(db.sql, {
    list: lister({ 'npm:app': listed('1.0.0') }).list,
    now: () => later,
  });

  expect(await checks(db.sql)).toMatchObject([
    { releases: { '': '1.0.0' }, succeeded_at: new Date(later) },
  ]);
  expect((await releases(db.sql)).map(({ version }) => version)).toEqual(['1.0.0', '1.1.0']);
});

test('a failed check keeps the last answer, records why, and a later success clears it', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'app', upstream: 'npm:app' });
  await checkUpstreams(db.sql, {
    list: lister({ 'npm:app': listed('1.0.0') }).list,
    now: () => NOW,
  });

  const failedAt = NOW + UPSTREAM_CHECK_INTERVAL_MS;
  await checkUpstreams(db.sql, {
    list: lister({
      'npm:app': { kind: 'failed', reason: 'registry.npmjs.org answered 503.' },
    }).list,
    now: () => failedAt,
  });
  expect(await checks(db.sql)).toEqual([
    {
      checked_at: new Date(failedAt),
      failure: 'registry.npmjs.org answered 503.',
      next_check_at: new Date(failedAt + UPSTREAM_CHECK_INTERVAL_MS),
      releases: { '': '1.0.0' },
      succeeded_at: new Date(NOW),
      upstream: 'npm:app',
    },
  ]);

  const recoveredAt = failedAt + UPSTREAM_CHECK_INTERVAL_MS;
  await checkUpstreams(db.sql, {
    list: lister({ 'npm:app': listed('1.0.0') }).list,
    now: () => recoveredAt,
  });
  expect(await checks(db.sql)).toMatchObject([
    { failure: null, succeeded_at: new Date(recoveredAt) },
  ]);
});

test('an upstream that never answered has no releases', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'app', upstream: 'npm:app' });

  await checkUpstreams(db.sql, {
    list: lister({ 'npm:app': { kind: 'failed', reason: 'down' } }).list,
    now: () => NOW,
  });

  expect(await checks(db.sql)).toMatchObject([
    { failure: 'down', releases: null, succeeded_at: null },
  ]);
});

test('a rate limit defers that upstream to its reset and skips its host for the rest of the pass', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'a', upstream: 'github:o/a' });
  await runs(db.sql, { service: 'b', upstream: 'github:o/b' });
  await runs(db.sql, { service: 'c', upstream: 'npm:c' });
  const reset = NOW + 20 * 60_000;
  const { asked, list } = lister({
    'github:o/a': {
      kind: 'limited',
      reason: 'api.github.com is rate-limiting the Hub.',
      retryAt: reset,
    },
    'npm:c': listed('1.0.0'),
  });

  await checkUpstreams(db.sql, { list, now: () => NOW });

  expect(asked).toEqual(['github:o/a', 'npm:c']);
  expect(await checks(db.sql)).toMatchObject([
    { next_check_at: new Date(reset), upstream: 'github:o/a' },
    { upstream: 'npm:c' },
  ]);
});

test('a reset time already past waits the usual interval', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'a', upstream: 'github:o/a' });

  await checkUpstreams(db.sql, {
    list: lister({ 'github:o/a': { kind: 'limited', reason: 'limited', retryAt: NOW - 1 } }).list,
    now: () => NOW,
  });

  expect(await checks(db.sql)).toMatchObject([
    { next_check_at: new Date(NOW + UPSTREAM_CHECK_INTERVAL_MS) },
  ]);
});

test('only the current upstreams of recorded Services are checked, each once', async () => {
  await using db = await database();
  // An upstream the Service has moved away from.
  await runs(db.sql, {
    at: NOW - 2 * HOUR,
    service: 'web',
    upstream: 'oci:docker.io/library/httpd',
  });
  await runs(db.sql, { service: 'web', upstream: 'oci:docker.io/library/nginx' });
  await runs(db.sql, {
    service: 'web',
    system: 'laptop-1',
    upstream: 'oci:docker.io/library/nginx',
  });
  await runs(db.sql, { service: 'pkg', upstream: 'apt:nginx' });
  await runs(db.sql, { service: 'tap', upstream: 'brew:git' });
  await runs(db.sql, { service: 'odd', upstream: 'free text' });
  await runs(db.sql, { service: 'none', upstream: null });
  await runs(db.sql, { forgotten: true, service: 'gone', upstream: 'npm:gone' });
  const { asked, list } = lister({ 'oci:docker.io/library/nginx': listed('1.27') });

  await checkUpstreams(db.sql, { list, now: () => NOW });

  expect(asked).toEqual(['oci:docker.io/library/nginx']);
});

test('upstreams never checked go first, then the longest overdue', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'a', upstream: 'npm:a' });
  await checkUpstreams(db.sql, { list: lister({ 'npm:a': listed('1.0.0') }).list, now: () => NOW });
  await runs(db.sql, { service: 'b', upstream: 'npm:b' });
  await runs(db.sql, { service: 'c', upstream: 'npm:c' });
  const { asked, list } = lister({
    'npm:a': listed('1.0.0'),
    'npm:b': listed('1.0.0'),
    'npm:c': listed('1.0.0'),
  });

  await checkUpstreams(db.sql, { list, now: () => NOW + UPSTREAM_CHECK_INTERVAL_MS });

  expect(asked).toEqual(['npm:b', 'npm:c', 'npm:a']);
});

test('a stop ends the pass without storing the answer it cut short', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'a', upstream: 'npm:a' });
  await runs(db.sql, { service: 'b', upstream: 'npm:b' });
  const stop = new AbortController();
  const asked: string[] = [];

  await checkUpstreams(db.sql, {
    list: (upstream) => {
      asked.push(upstream);
      stop.abort();
      return Promise.resolve({
        kind: 'failed',
        reason: 'This operation was aborted.',
      });
    },
    now: () => NOW,
    signal: stop.signal,
  });

  expect(asked).toEqual(['npm:a']);
  expect(await checks(db.sql)).toEqual([]);
});

test('a rate limit with no reset time still spares its host for the rest of the pass', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'a', upstream: 'github:o/a' });
  await runs(db.sql, { service: 'b', upstream: 'github:o/b' });
  const { asked, list } = lister({
    'github:o/a': { kind: 'limited', reason: 'limited', retryAt: null },
  });

  await checkUpstreams(db.sql, { list, now: () => NOW });

  expect(asked).toEqual(['github:o/a']);
  expect(await checks(db.sql)).toMatchObject([
    { next_check_at: new Date(NOW + UPSTREAM_CHECK_INTERVAL_MS), upstream: 'github:o/a' },
  ]);
});

test('a reset time far off defers a check by a day at most', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'a', upstream: 'github:o/a' });

  await checkUpstreams(db.sql, {
    list: lister({
      'github:o/a': { kind: 'limited', reason: 'limited', retryAt: Date.UTC(2099, 0, 1) },
    }).list,
    now: () => NOW,
  });

  expect(await checks(db.sql)).toMatchObject([{ next_check_at: new Date(NOW + 24 * HOUR) }]);
});

test('when a release was first found never moves, though it is listed again or withdrawn and restored', async () => {
  await using db = await database();
  await runs(db.sql, { service: 'app', upstream: 'npm:app' });
  const answers = [listed('1.1.0'), listed('1.1.0'), listed('1.0.0'), listed('1.1.0')];
  for (const [index, answer] of answers.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each check follows the last.
    await checkUpstreams(db.sql, {
      list: lister({ 'npm:app': answer }).list,
      now: () => NOW + index * UPSTREAM_CHECK_INTERVAL_MS,
    });
  }

  expect(await releases(db.sql)).toEqual([
    {
      first_found_at: new Date(NOW + 2 * UPSTREAM_CHECK_INTERVAL_MS),
      upstream: 'npm:app',
      version: '1.0.0',
    },
    { first_found_at: new Date(NOW), upstream: 'npm:app', version: '1.1.0' },
  ]);
});

test('a Service whose upstream became unknown is no longer checked for its old one', async () => {
  await using db = await database();
  await runs(db.sql, { at: NOW - 2 * HOUR, service: 'app', upstream: 'npm:app' });
  await runs(db.sql, { service: 'app', upstream: null });
  const { asked, list } = lister({});

  await checkUpstreams(db.sql, { list, now: () => NOW });

  expect(asked).toEqual([]);
});
