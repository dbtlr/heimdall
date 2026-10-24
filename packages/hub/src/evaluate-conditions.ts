import type { SQL } from 'bun';

import { evaluateClockConditions } from './clock-conditions.ts';
import { evaluateDrift } from './drift.ts';
import { describeError } from './errors.ts';
import { evaluateHotProcessConditions } from './hot-process-conditions.ts';
import { evaluateJobConditions } from './job-conditions.ts';
import { evaluateLoadConditions } from './load-conditions.ts';
import { evaluateServiceConditions } from './service-conditions.ts';
import { evaluateServiceStopConditions } from './service-stop-conditions.ts';
import { evaluateSystemConditions } from './system-conditions.ts';
import type { SystemConditionThresholds } from './system-conditions.ts';
import { evaluateUpdateConditions } from './update-conditions.ts';

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

// Judges the Hub's Conditions in turn, with Service restarted after Service
// down, each at the time `clock` (epoch milliseconds) reads. `serve` runs it
// every minute.
export const evaluateConditions = (
  sql: SQL,
  clock: () => number,
  thresholds: SystemConditionThresholds,
): Promise<void> =>
  runInTurn([
    () => evaluateJobConditions(sql, clock),
    () => evaluateSystemConditions(sql, clock, thresholds),
    () => evaluateClockConditions(sql, clock, thresholds),
    () => evaluateLoadConditions(sql, clock, thresholds),
    () => evaluateHotProcessConditions(sql, clock, thresholds),
    () => evaluateUpdateConditions(sql, clock, thresholds),
    () => evaluateDrift(sql, clock),
    () => evaluateServiceConditions(sql, clock),
    () => evaluateServiceStopConditions(sql, clock),
  ]);
