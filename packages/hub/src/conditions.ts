import type { ConditionLevel } from '@heimdall/schema';
import type { SQL } from 'bun';

import { describeError } from './errors.ts';
import type { ConditionKind } from './store.ts';

export const FIXED_LEVELS = {
  drift: 'warning',
  job_failing: 'alert',
  job_overdue: 'warning',
  reports_rejected: 'alert',
  service_down: 'alert',
  system_stale: 'alert',
} as const satisfies Record<
  Exclude<ConditionKind, 'low_disk' | 'high_cpu' | 'high_memory'>,
  ConditionLevel
>;

type Judgment = {
  now: Date;
  reason: string;
  subject: string;
  system: string;
} & (
  | { kind: 'low_disk' | 'high_cpu' | 'high_memory'; level: ConditionLevel }
  | { kind: keyof typeof FIXED_LEVELS }
);

// Callers hold the System's row lock in this transaction. Level and history
// must commit together, including when the Hub's wall clock moves backwards.
export const raise = async (tx: SQL, judgment: Judgment) => {
  const { kind, now, reason, subject, system } = judgment;
  const level = 'level' in judgment ? judgment.level : FIXED_LEVELS[judgment.kind];
  const [held]: { id: string; level: ConditionLevel; at: Date }[] = await tx`
    SELECT c.id, c.level, GREATEST(c.raised_at, (
      SELECT max(at) FROM condition_transitions WHERE condition = c.id
    )) AS at
    FROM conditions c
    WHERE system = ${system} AND kind = ${kind} AND subject = ${subject} AND cleared_at IS NULL
  `;
  // Each rejection is new evidence even with the same reason. Routine
  // reevaluation of other Conditions does not refresh their evidence.
  const [changed]: { id: string }[] = await tx`
    INSERT INTO conditions (system, kind, subject, level, raised_at, raised_reason, latest_at, latest_reason)
    VALUES (${system}, ${kind}, ${subject}, ${level}, ${now}, ${reason}, ${now}, ${reason})
    ON CONFLICT (system, kind, subject) WHERE cleared_at IS NULL DO UPDATE SET
      level = excluded.level,
      latest_at = excluded.latest_at,
      latest_reason = excluded.latest_reason
    WHERE conditions.latest_reason <> excluded.latest_reason OR conditions.level <> excluded.level
      OR conditions.kind = 'reports_rejected'
    RETURNING id
  `;
  if (changed === undefined || held?.level === level) {
    return;
  }
  const at = new Date(Math.max(now.getTime(), held?.at.getTime() ?? now.getTime()));
  await tx`
    INSERT INTO condition_transitions (condition, action, level, previous_level, at, reason)
    VALUES (${changed.id}, ${held === undefined ? 'raised' : 'level_changed'}, ${level},
            ${held?.level ?? null}, ${at}, ${reason})
  `;
};

// Clears the open Condition of `kind` about `subject`, if there is one.
export const clear = async (
  tx: SQL,
  {
    kind,
    now,
    subject,
    system,
  }: { kind: ConditionKind; now: Date; subject: string; system: string },
) => {
  await tx`
    WITH cleared AS (
      UPDATE conditions c SET cleared_at = GREATEST(raised_at, ${now}, (
        SELECT max(at) FROM condition_transitions WHERE condition = c.id
      ))
      WHERE system = ${system} AND kind = ${kind} AND subject = ${subject} AND cleared_at IS NULL
      RETURNING id, level, cleared_at, latest_reason
    )
    INSERT INTO condition_transitions (condition, action, level, at, reason)
    SELECT id, 'cleared', level, cleared_at, latest_reason FROM cleared
  `;
};

type RecordedLevel = { level: ConditionLevel; reason: string };

// Records a recovered episode without touching another occurrence that is
// currently open. Callers hold the System lock, as they do for raise and clear.
export const recordClosedOccurrence = async (
  tx: SQL,
  {
    kind,
    now,
    steps,
    subject,
    system,
  }: {
    kind: ConditionKind;
    now: Date;
    steps: [RecordedLevel, ...RecordedLevel[]];
    subject: string;
    system: string;
  },
) => {
  const first = steps[0];
  const last = steps.at(-1) ?? first;
  const [saved]: { id: string }[] = await tx`
    INSERT INTO conditions (
      system, kind, subject, level, raised_at, raised_reason,
      latest_at, latest_reason, cleared_at
    )
    VALUES (${system}, ${kind}, ${subject}, ${last.level}, ${now}, ${first.reason},
            ${now}, ${last.reason}, ${now})
    RETURNING id
  `;
  if (saved === undefined) {
    throw new Error('A recovered Condition was not stored.');
  }
  let previous: ConditionLevel | undefined;
  for (const step of steps) {
    // oxlint-disable-next-line no-await-in-loop -- transition IDs preserve the sampled level order.
    await tx`
      INSERT INTO condition_transitions (condition, action, level, previous_level, at, reason)
      VALUES (${saved.id}, ${previous === undefined ? 'raised' : 'level_changed'}, ${step.level},
              ${previous ?? null}, ${now}, ${step.reason})
    `;
    previous = step.level;
  }
  await tx`
    INSERT INTO condition_transitions (condition, action, level, at, reason)
    VALUES (${saved.id}, 'cleared', ${last.level}, ${now}, ${last.reason})
  `;
  return saved.id;
};

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
