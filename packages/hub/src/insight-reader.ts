import { every } from '@heimdall/service';
import type { RuntimeLog } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { SQL } from 'bun';

import { describeError } from './errors.ts';
import { MIGRATION_LOCK, MIGRATION_LOCK_TIMEOUT_MS } from './migrations.ts';

// A role the Hub's configuration can name as the insight reader: a lowercase
// name PostgreSQL needs no quotes for, of at most 63 characters, other than
// `public`, `none`, and the `pg_` roles PostgreSQL reserves, which stand for
// more than one role.
export const INSIGHT_READER_ROLE = /^(?!pg_|public$|none$)[a-z_][a-z0-9_]{0,62}$/u;

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

// What a grant did: the role did not exist, it was granted, or it was refused
// because it reads every table already: it is the Hub's own role, a
// superuser, a member of the Hub's role, or a member of `pg_read_all_data`.
export type ReaderGrant =
  | { kind: 'absent' }
  | { kind: 'granted' }
  | { kind: 'refused'; reason: 'hub' | 'member' | 'readsAll' | 'superuser' };

// Lets `role` read the `insight` views and nothing else: USAGE on the schema
// and SELECT on every view in it. The views run with their owner's rights, so
// the role needs, and gets, no access to the tables beneath them, and each is
// a security barrier, so the role's own filters see only the rows a view shows.
//
// The provisioner creates the role, so it may not exist yet: then nothing is
// granted, and the answer says so. A role that reads every table already is
// refused, since a grant would suggest it reads less. `serve` grants after the
// migrations, which covers views made before the role existed and a view a
// migration dropped and created again, which loses its grants. Default
// privileges cover a view the Hub's role creates later in the schema, such as
// one a newer `heimdall-hub` command's migration makes before `serve` restarts.
// Granting again changes nothing. It holds the migration lock, so no migration
// replaces a view while it grants, and waits for it at most `lockTimeoutMs`.
export const grantInsightReader = (
  sql: SQL,
  role: string,
  { lockTimeoutMs = MIGRATION_LOCK_TIMEOUT_MS }: { lockTimeoutMs?: number } = {},
): Promise<ReaderGrant> =>
  sql.begin(async (tx): Promise<ReaderGrant> => {
    await tx`SELECT set_config('lock_timeout', ${`${String(lockTimeoutMs)}ms`}, true)`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    const [found]: { hub: boolean; member: boolean; readsAll: boolean; superuser: boolean }[] =
      await tx`
      SELECT r.rolname = current_user AS hub, r.rolsuper AS superuser,
             pg_has_role(r.oid, (SELECT oid FROM pg_roles WHERE rolname = current_user), 'MEMBER')
               AS member,
             coalesce(
               pg_has_role(r.oid, (SELECT oid FROM pg_roles WHERE rolname = 'pg_read_all_data'), 'MEMBER'),
               false
             ) AS "readsAll"
      FROM pg_roles r WHERE r.rolname = ${role}
    `;
    if (found === undefined) {
      return { kind: 'absent' };
    }
    if (found.hub) {
      return { kind: 'refused', reason: 'hub' };
    }
    if (found.superuser) {
      return { kind: 'refused', reason: 'superuser' };
    }
    if (found.member) {
      return { kind: 'refused', reason: 'member' };
    }
    if (found.readsAll) {
      return { kind: 'refused', reason: 'readsAll' };
    }
    const grantee = quoted(role);
    await tx.unsafe(`
      GRANT USAGE ON SCHEMA insight TO ${grantee};
      GRANT SELECT ON ALL TABLES IN SCHEMA insight TO ${grantee};
      ALTER DEFAULT PRIVILEGES IN SCHEMA insight GRANT SELECT ON TABLES TO ${grantee};
    `);
    return { kind: 'granted' };
  });

// Stops every role but the database's owner creating temporary tables in the
// Hub's database, which PostgreSQL lets every role do by default, so the
// insight reader writes nothing there. The Hub creates none. Only the owner
// can revoke it, so a Hub whose role does not own its database changes
// nothing and answers false.
export const revokePublicTemporaryTables = async (sql: SQL): Promise<boolean> => {
  const [database]: { name: string; owns: boolean }[] = await sql`
    SELECT datname AS name, pg_has_role(current_user, datdba, 'MEMBER') AS owns
    FROM pg_database WHERE datname = current_database()
  `;
  if (database?.owns !== true) {
    return false;
  }
  await sql.unsafe(`REVOKE TEMPORARY ON DATABASE ${quoted(database.name)} FROM PUBLIC`);
  return true;
};

// What stops tries that never started.
const nothingToStop = async () => {};

// How often `serve` tries again to grant a reader it could not.
export const GRANT_RETRY_MS = 60_000;

const REFUSALS = {
  hub: "it is the Hub's own role, which reads every table",
  member: "it is a member of the Hub's role, so it reads every table the Hub reads",
  readsAll: 'it is a member of pg_read_all_data, which reads every table',
  superuser: 'it is a superuser, which reads every table',
} as const;

// `serve`'s insight reader: stops other roles creating temporary tables,
// grants `reader` the insight views, and logs what it did. A reader that does
// not exist yet, or a grant that fails, such as on a lock a backup holds, is
// tried again every `intervalMs` until it is granted, so a role the
// provisioner creates while `serve` runs is granted within that time. None of
// it stops `serve`. `clean` makes an error's message safe to log. It answers
// a function that stops the tries.
export const keepInsightReaderGranted = async ({
  clean = escapeControlCharacters,
  intervalMs = GRANT_RETRY_MS,
  lockTimeoutMs,
  log,
  reader,
  sql,
}: {
  clean?: (message: string) => string;
  intervalMs?: number;
  lockTimeoutMs?: number;
  log: RuntimeLog;
  reader: string;
  sql: SQL;
}): Promise<() => Promise<void>> => {
  try {
    if (!(await revokePublicTemporaryTables(sql))) {
      await log.warn(
        "The Hub's role does not own its database, so every role, the insight reader included, can still create temporary tables there.",
      );
    }
  } catch (error) {
    await log.warn(
      clean(`Could not stop other roles creating temporary tables: ${describeError(error)}`),
    );
  }
  let absentLogged = false;
  // One try: whether to stop trying.
  const attempt = async (): Promise<boolean> => {
    try {
      const grant = await grantInsightReader(
        sql,
        reader,
        lockTimeoutMs === undefined ? {} : { lockTimeoutMs },
      );
      switch (grant.kind) {
        case 'granted': {
          await log.info(`Granted ${reader} read access to the insight views.`);
          return true;
        }
        case 'refused': {
          await log.warn(
            `Granted ${reader} nothing: ${REFUSALS[grant.reason]}. Name a role of its own as the insight reader.`,
          );
          return true;
        }
        case 'absent': {
          if (!absentLogged) {
            absentLogged = true;
            await log.warn(
              `The insight reader role ${reader} does not exist yet, so serve granted it nothing. Serve grants it once the provisioner creates it.`,
            );
          }
          return false;
        }
        default: {
          const _exhaustive: never = grant;
          return _exhaustive;
        }
      }
    } catch (error) {
      await log.warn(
        clean(
          `Could not grant ${reader} read access to the insight views: ${describeError(error)}. Serve tries again.`,
        ),
      );
      return false;
    }
  };
  if (await attempt()) {
    return nothingToStop;
  }
  let stop = nothingToStop;
  stop = every({
    intervalMs,
    onError: () => {},
    runNow: false,
    task: async () => {
      if (await attempt()) {
        // Stopping from within a run leaves that run to finish and schedules no other.
        void stop();
      }
    },
  });
  return stop;
};
