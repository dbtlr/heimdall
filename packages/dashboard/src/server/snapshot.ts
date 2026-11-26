import type { SQL } from 'bun';

// Reads in one `REPEATABLE READ` snapshot on one connection, with JIT off:
// the indexed reads finish faster than PostgreSQL can compile them. This is
// how every dashboard snapshot begins. `read` must settle every read it
// starts before it returns, as the transaction ends when it does.
export const readSnapshot = <T>(sql: SQL, read: (tx: SQL) => Promise<T>): Promise<T> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    await tx`SET LOCAL jit = off`;
    return read(tx);
  });

// The reads' values once all settle, or the first one's error, as
// Promise.all gives them: no transaction ends while a read on it is still
// running, as a snapshot's reads must.
export const settleAll = async <T extends readonly unknown[]>(
  reads: readonly [...T],
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> => {
  const settled = await Promise.allSettled(reads);
  const failed = settled.find((read): read is PromiseRejectedResult => read.status === 'rejected');
  if (failed !== undefined) {
    throw failed.reason;
  }
  return Promise.all(reads);
};

// Both reads' values once both settle, or the first one's error.
export const settleBoth = <A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> =>
  settleAll([a, b]);
