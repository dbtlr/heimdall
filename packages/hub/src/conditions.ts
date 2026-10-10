import type { SQL } from 'bun';

import { describeError } from './errors.ts';
import type { ConditionKind } from './store.ts';

// Raises the Condition of `kind` about `subject`, or gives the one already
// open this reason. An open Condition keeps the time it was raised.
export const raise = (
  tx: SQL,
  {
    kind,
    now,
    reason,
    subject,
    system,
  }: { kind: ConditionKind; now: Date; reason: string; subject: string; system: string },
) => tx`
  INSERT INTO conditions (system, kind, subject, raised_at, raised_reason, latest_at, latest_reason)
  VALUES (${system}, ${kind}, ${subject}, ${now}, ${reason}, ${now}, ${reason})
  ON CONFLICT (system, kind, subject) WHERE cleared_at IS NULL DO UPDATE SET
    latest_at = excluded.latest_at,
    latest_reason = excluded.latest_reason
  WHERE conditions.latest_reason <> excluded.latest_reason
`;

// Clears the open Condition of `kind` about `subject`, if there is one.
export const clear = (
  tx: SQL,
  {
    kind,
    now,
    subject,
    system,
  }: { kind: ConditionKind; now: Date; subject: string; system: string },
) => tx`
  UPDATE conditions SET cleared_at = GREATEST(raised_at, ${now})
  WHERE system = ${system} AND kind = ${kind} AND subject = ${subject} AND cleared_at IS NULL
`;

// Runs `evaluate` for each System in turn. A System that cannot be judged does
// not stop the rest; one error then names each such System and why.
export const evaluateEach = async (
  systems: readonly string[],
  evaluate: (system: string) => Promise<void>,
): Promise<void> => {
  const failures: { error: unknown; system: string }[] = [];
  for (const system of systems) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one System at a time keeps the load even.
      await evaluate(system);
    } catch (error) {
      failures.push({ error, system });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      failures.map((f) => `${f.system}: ${describeError(f.error)}`).join('; '),
    );
  }
};
