import type { SQL } from 'bun';

// Match projectOf in SQL, including root repositories falling back to cwd.
export const projectNameSql = (
  sql: SQL,
  repository: SQL.Query<unknown>,
  cwd: SQL.Query<unknown>,
) => sql`
  coalesce(nullif(substring(rtrim(${repository}, '/') from '[^/]+$'), ''),
           nullif(substring(rtrim(${cwd}, '/') from '[^/]+$'), ''))
`;

export const sessionProjectSql = (sql: SQL) =>
  projectNameSql(sql, sql` s.repository `, sql` coalesce(s.last_cwd, s.first_cwd) `);
