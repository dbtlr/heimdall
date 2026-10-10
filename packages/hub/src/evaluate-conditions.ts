import type { SQL } from 'bun';

import { describeError } from './errors.ts';
import { evaluateJobConditions } from './job-conditions.ts';
import { evaluateSystemConditions } from './system-conditions.ts';
import type { SystemConditionThresholds } from './system-conditions.ts';

// Runs each evaluator after the one before it, so they never compete for a
// System's lock. One that fails does not stop the others; the one error that
// follows carries every failure.
export const runInTurn = async (evaluators: readonly (() => Promise<void>)[]): Promise<void> => {
  const errors: unknown[] = [];
  for (const evaluate of evaluators) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one evaluator at a time.
      await evaluate();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(describeError).join('; '));
  }
};

// Judges every Condition the Hub derives from what it holds: the job
// Conditions, then the stale System and low disk Conditions, each at the time
// `clock` (epoch milliseconds) reads. `serve` runs it every minute.
export const evaluateConditions = (
  sql: SQL,
  clock: () => number,
  thresholds: SystemConditionThresholds,
): Promise<void> =>
  runInTurn([
    () => evaluateJobConditions(sql, clock),
    () => evaluateSystemConditions(sql, clock, thresholds),
  ]);
