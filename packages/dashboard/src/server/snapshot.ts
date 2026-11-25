import type { SQL } from 'bun';

const SNAPSHOT = 'ISOLATION LEVEL REPEATABLE READ READ ONLY';
// How many reads of each pool hold a second connection now.
const lending = new WeakMap<SQL, number>();

// Begins a snapshot on `tx` with JIT off: the indexed reads finish faster
// than PostgreSQL can compile them.
const begin = <T>(sql: SQL, read: (tx: SQL) => Promise<T>) =>
  sql.begin(SNAPSHOT, async (tx) => {
    await tx`SET LOCAL jit = off`;
    return read(tx);
  });

// Reads in one snapshot. With `lend`, `read` also gets a second transaction
// on the same snapshot, on another of the pool's connections, to run reads
// beside its own; without it, or while the pool lends to as many reads as it
// holds connection pairs beside one connection kept for other reads (four on
// Bun's default pool of 10), both are the same transaction. Lending to fewer
// than half the pool's connections means a read holding one connection while
// it waits for its second always gets one, as the others are held by reads
// that need nothing more, and a short read never waits for every connection
// to be lent. `read` must settle every read it starts before it returns, as
// both transactions end when it does.
export const readSnapshot = async <T>(
  sql: SQL,
  lend: boolean,
  read: (tx: SQL, side: SQL) => Promise<T>,
): Promise<T> => {
  const lent = lending.get(sql) ?? 0;
  // Bun's pool holds 10 connections when no size is given.
  const pairs = Math.floor(((sql.options.max ?? 10) - 1) / 2);
  if (!lend || lent >= pairs) {
    return begin(sql, (tx) => read(tx, tx));
  }
  lending.set(sql, lent + 1);
  try {
    return await begin(sql, async (tx) => {
      const [row]: { snapshot: string }[] = await tx`SELECT pg_export_snapshot() AS snapshot`;
      if (row === undefined || !/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/iu.test(row.snapshot)) {
        throw new Error('PostgreSQL returned an invalid snapshot identifier');
      }
      return sql.begin(SNAPSHOT, async (side) => {
        await side.unsafe(`SET TRANSACTION SNAPSHOT '${row.snapshot}'`);
        await side`SET LOCAL jit = off`;
        return read(tx, side);
      });
    });
  } finally {
    lending.set(sql, (lending.get(sql) ?? 1) - 1);
  }
};

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
