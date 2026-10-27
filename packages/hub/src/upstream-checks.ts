import { newestPerChannel } from '@heimdall/schema';
import type { SQL } from 'bun';

import { storableJson } from './storable.ts';
import { checkedUpstream } from './upstream-releases.ts';
import type { CheckAnswer } from './upstream-releases.ts';

// How long the Hub waits after checking an upstream before it checks it again,
// whether the check succeeded or failed (ADR-0022: at most every few hours).
export const UPSTREAM_CHECK_INTERVAL_MS = 6 * 3_600_000;

// The host that answers for an upstream, so a rate limit from one host spares
// the others for the rest of a pass.
const hostOf = (upstream: string) =>
  (upstream.startsWith('oci:') ? upstream.slice(4) : upstream).split(/[/:]/u)[0] ?? upstream;

// The upstreams due a check: the current upstream of each Service a System
// still records, once however many Services share it, never-checked ones
// first and then the longest overdue.
const dueUpstreams = async (sql: SQL, now: number) => {
  const rows: { upstream: string }[] = await sql`
    WITH current AS (
      SELECT DISTINCT ON (v.system, v.service) v.system, v.service, v.upstream
      FROM service_versions v
      ORDER BY v.system, v.service, v.first_seen_at DESC
    )
    SELECT c.upstream, min(u.next_check_at) AS next_check_at
    FROM current c
    JOIN mirrored_records r ON r.system = c.system AND r.kind = 'service' AND r.name = c.service
    LEFT JOIN upstream_checks u ON u.upstream = c.upstream
    WHERE c.upstream IS NOT NULL
      AND (u.next_check_at IS NULL OR u.next_check_at <= ${new Date(now)})
    GROUP BY c.upstream
    ORDER BY next_check_at NULLS FIRST, c.upstream
  `;
  return rows.map(({ upstream }) => upstream).filter(checkedUpstream);
};

// Stores one check's answer. A listing replaces the newest release per
// channel and records when each was first found; a failure keeps them.
const storeAnswer = async (
  sql: SQL,
  { answer, now, upstream }: { answer: CheckAnswer; now: number; upstream: string },
) => {
  const at = new Date(now);
  if (answer.kind === 'failed') {
    const retryAt =
      answer.retryAt !== null && answer.retryAt > now
        ? answer.retryAt
        : now + UPSTREAM_CHECK_INTERVAL_MS;
    await sql`
      INSERT INTO upstream_checks (upstream, releases, checked_at, succeeded_at, failure, next_check_at)
      VALUES (${upstream}, NULL, ${at}, NULL, ${answer.reason}, ${new Date(retryAt)})
      ON CONFLICT (upstream) DO UPDATE SET
        checked_at = excluded.checked_at, failure = excluded.failure,
        next_check_at = excluded.next_check_at
    `;
    return;
  }
  const newest = newestPerChannel(answer.releases);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO upstream_checks (upstream, releases, checked_at, succeeded_at, failure, next_check_at)
      VALUES (${upstream}, ${storableJson(newest)}::text::jsonb, ${at}, ${at}, NULL,
              ${new Date(now + UPSTREAM_CHECK_INTERVAL_MS)})
      ON CONFLICT (upstream) DO UPDATE SET
        releases = excluded.releases, checked_at = excluded.checked_at,
        succeeded_at = excluded.succeeded_at, failure = NULL,
        next_check_at = excluded.next_check_at
    `;
    await tx`
      INSERT INTO upstream_releases (upstream, version, first_found_at)
      SELECT ${upstream}, version, ${at}
      FROM jsonb_array_elements_text(${storableJson(Object.values(newest))}::text::jsonb) AS version
      ON CONFLICT (upstream, version) DO NOTHING
    `;
  });
};

// One pass of the Hub's upstream checks: asks each due upstream for its
// releases, one at a time, and stores what it found. After a rate limit, the
// pass asks nothing more of that host; the next pass tries its other
// upstreams again. Once `signal` aborts, the pass stops and stores no answer
// the stop cut short.
export const checkUpstreams = async (
  sql: SQL,
  {
    list,
    now,
    signal,
  }: {
    list: (upstream: string) => Promise<CheckAnswer>;
    now: () => number;
    signal?: AbortSignal;
  },
) => {
  const limited = new Set<string>();
  for (const upstream of await dueUpstreams(sql, now())) {
    const host = hostOf(upstream);
    if (limited.has(host)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one request at a time spares each upstream.
    const answer = await list(upstream);
    if (signal?.aborted === true) {
      return;
    }
    if (answer.kind === 'failed' && answer.retryAt !== null) {
      limited.add(host);
    }
    // oxlint-disable-next-line no-await-in-loop -- each answer is stored as it arrives.
    await storeAnswer(sql, { answer, now: now(), upstream });
  }
};
