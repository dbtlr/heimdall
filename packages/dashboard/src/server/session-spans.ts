import type { SQL } from 'bun';

import { sessionProjectSql } from './project-sql.ts';

// The Sessions whose latest request is at or after `from` and whose first
// request is at or before `to`, using the bounds of their stored stretches.
// The end-time index supplies the recent Sessions. The optional project
// filter reads their metadata by key.
export const sessionSpans = (
  sql: SQL,
  {
    from,
    project,
    system,
    to,
  }: { from: Date; project?: string | undefined; system?: string | undefined; to: Date },
) => sql`
  SELECT k.harness, k.system, k.source, k.session_id, k.first_request_at, k.last_request_at
  FROM insight.session_spans k
  WHERE k.last_request_at >= ${from} AND k.first_request_at <= ${to}
    ${system === undefined ? sql`` : sql`AND k.system = ${system}`}
    ${
      project === undefined
        ? sql``
        : sql`AND EXISTS (
      SELECT 1 FROM insight.sessions s
      WHERE (s.harness, s.system, s.source, s.session_id) = (k.harness, k.system, k.source, k.session_id)
        AND ${sessionProjectSql(sql)} = ${project}
    )`
    }
`;
