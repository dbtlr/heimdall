import type { SQL } from 'bun';

import { describeError } from './errors.ts';

export type HubPass =
  | 'prune'
  | 'conditions'
  | 'delivery'
  | 'parse'
  | 'refresh'
  | 'listening'
  | 'upstreams';

// Runtime bookkeeping must never prevent the work it describes. last_runs
// records completed attempts (including failed attempts), using epoch milliseconds.
export const hubStatusRecorder = ({
  sql,
  now,
  warn,
}: {
  sql: SQL;
  now: () => number;
  warn: (message: string) => void;
}) => {
  const safely = async (write: () => Promise<unknown>) => {
    try {
      await write();
    } catch (error) {
      warn(`Could not record Hub status: ${describeError(error)}`);
    }
  };
  return {
    pass: async (name: HubPass, task: () => Promise<unknown>) => {
      try {
        await task();
      } finally {
        await safely(
          () => sql`
          UPDATE hub_status SET last_runs = last_runs || ${sql.json({ [name]: now() })}::jsonb
          WHERE only_row
        `,
        );
      }
    },
    start: ({ version, deliveryConfigured }: { version: string; deliveryConfigured: boolean }) =>
      safely(
        () => sql`
      INSERT INTO hub_status (version, started_at, delivery_configured)
      VALUES (${version}, ${new Date(now())}, ${deliveryConfigured})
      ON CONFLICT (only_row) DO UPDATE SET version = EXCLUDED.version,
        started_at = EXCLUDED.started_at, delivery_configured = EXCLUDED.delivery_configured,
        last_runs = '{}'::jsonb
    `,
      ),
  };
};
