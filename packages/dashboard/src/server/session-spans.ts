import type { SQL } from 'bun';

// The Sessions whose latest request is at or after `from` and whose first is
// at or before `to`, each with those two times over all its stored stretches
// (ADR-0016), as a fragment to nest in a statement. A Session's latest request
// is at or after `from` exactly when one of its stretches ends then, so the
// index on the stretches' end finds both the Sessions and their latest
// request. Each Session's first request, though it began before `from`, is
// the earliest start of its own stretches, read by key. The cost follows the
// stretches ending since `from` and those Sessions' stretches, not the whole
// archive.
export const sessionSpans = (sql: SQL, { from, to }: { from: Date; to: Date }) => sql`
  SELECT k.harness, k.system, k.source, k.session_id, f.first_request_at, k.last_request_at
  FROM (
    SELECT harness, system, source, session_id, max(ended_at) AS last_request_at
    FROM insight.session_stretches
    WHERE ended_at >= ${from}
    GROUP BY harness, system, source, session_id
  ) k
  CROSS JOIN LATERAL (
    SELECT min(x.started_at) AS first_request_at
    FROM insight.session_stretches x
    WHERE (x.harness, x.system, x.source, x.session_id)
        = (k.harness, k.system, k.source, k.session_id)
  ) f
  WHERE f.first_request_at <= ${to}
`;
