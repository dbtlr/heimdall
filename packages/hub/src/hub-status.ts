import type { SQL } from 'bun';

import { describeError } from './errors.ts';

export type HubPass =
  | 'prune'
  | 'conditions'
  | 'delivery'
  | 'parse'
  | 'refresh'
  | 'listening'
  | 'upstreams'
  | 'prices';

// How serve runs a pass: `every` starts the next run `intervalMs` after the
// previous one finished, and `budgetMs` is the longest one run is meant to
// take. The dashboard judges a pass overdue from both (docs/spec.md). A pass
// its configuration turns `off` never runs.
export type PassSchedule = { intervalMs: number; budgetMs: number; off?: true };

// What `last_runs` holds for one pass, its times in epoch milliseconds: its
// schedule, when its latest run started and finished, when a run last
// succeeded, and, while its runs keep failing, when the first of them failed.
// A run in progress has a `started_at` later than its `finished_at`. A pass
// that is off says so in place of run times.
export type PassRecord = {
  interval_ms: number;
  budget_ms: number;
  off?: true;
  started_at?: number;
  finished_at?: number;
  succeeded_at?: number;
  failing_since?: number;
};

// How long a status write waits for a lock another session holds on the row,
// so a held row costs a timer pass at most this before it carries on.
export const STATUS_LOCK_TIMEOUT_MS = 1000;

// Runtime bookkeeping must never prevent the work it describes: a failed
// write, a held lock included, is logged through `warn` and the pass goes on.
// One process writes its passes' records, so they are kept here and each
// write stores a pass's whole record. `start` replaces the previous process's
// row, so serve calls it only once it listens: a Hub that fails to start
// leaves the running Hub's row alone.
export const hubStatusRecorder = ({
  lockTimeoutMs = STATUS_LOCK_TIMEOUT_MS,
  now,
  sql,
  warn,
}: {
  lockTimeoutMs?: number;
  now: () => number;
  sql: SQL;
  warn: (message: string) => void;
}) => {
  let runs: Partial<Record<HubPass, PassRecord>> = {};
  // The start row while the database has refused it: each later write tries it
  // first, so a transient failure at start does not leave the row missing and
  // every pass write updating nothing until the next restart.
  let unstarted: ((tx: SQL) => Promise<unknown>) | undefined;
  const safely = async (write: (tx: SQL) => Promise<unknown>) => {
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('lock_timeout', ${`${String(lockTimeoutMs)}ms`}, true)`;
        await unstarted?.(tx);
        await write(tx);
      });
      unstarted = undefined;
    } catch (error) {
      warn(`Could not record Hub status: ${describeError(error)}`);
    }
  };
  const store = (name: HubPass, change: (run: PassRecord) => PassRecord) => {
    const run = change(runs[name] ?? { budget_ms: 0, interval_ms: 0 });
    runs[name] = run;
    return safely(
      (tx) =>
        tx`UPDATE hub_status SET last_runs = last_runs || ${tx.json({ [name]: run })}::jsonb
          WHERE only_row`,
    );
  };
  return {
    pass: async (name: HubPass, task: () => Promise<unknown>) => {
      await store(name, (run) => ({ ...run, started_at: now() }));
      try {
        await task();
      } catch (error) {
        await store(name, (run) => {
          const at = now();
          return { ...run, failing_since: run.failing_since ?? at, finished_at: at };
        });
        throw error;
      }
      await store(name, (run) => {
        const at = now();
        const succeeded: PassRecord = { ...run, finished_at: at, succeeded_at: at };
        delete succeeded.failing_since;
        return succeeded;
      });
    },
    start: ({
      deliveryConfigured,
      passes,
      version,
    }: {
      deliveryConfigured: boolean;
      passes: Partial<Record<HubPass, PassSchedule>>;
      version: string;
    }) => {
      runs = Object.fromEntries(
        Object.entries(passes).map(([name, { budgetMs, intervalMs, off }]) => [
          name,
          { budget_ms: budgetMs, interval_ms: intervalMs, ...(off === undefined ? {} : { off }) },
        ]),
      );
      const startedAt = new Date(now());
      // Writes the passes as they stand when it lands, so a retried start keeps
      // what the passes have recorded since.
      unstarted = (tx) => tx`
        INSERT INTO hub_status (version, started_at, delivery_configured, last_runs)
        VALUES (${version}, ${startedAt}, ${deliveryConfigured}, ${tx.json(runs)}::jsonb)
        ON CONFLICT (only_row) DO UPDATE SET version = EXCLUDED.version,
          started_at = EXCLUDED.started_at, delivery_configured = EXCLUDED.delivery_configured,
          last_runs = EXCLUDED.last_runs
      `;
      return safely(async () => {});
    },
  };
};
