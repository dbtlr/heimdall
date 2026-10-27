import type { SQL } from 'bun';

// Waits until `count` backends of this database wait on a lock.
export const waitersOnLocks = async (sql: SQL, count: number) => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polls until the waiters queue.
    const [row]: { n: number }[] = await sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if ((row?.n ?? 0) >= count) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until the waiters queue.
    await Bun.sleep(10);
  }
};
