import { SERVICE_CHECK_KINDS, SERVICE_CHECK_STATES } from '@heimdall/schema';
import type { ServiceCheck } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

import { awakeCutoffOf, latestBucketOf } from './awake-time.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import type { ConditionKind } from './store.ts';

const SERVICE_DOWN: ConditionKind = 'service_down';

// How long a check must have been failing before the Hub raises Service down.
export const SERVICE_DOWN_AFTER_MS = 2 * 60_000;

// What the Hub should do with one Service's Condition: raise it with a reason
// (or update the reason of the open one), clear it, or leave it as it is
// because what decides it is unknown.
type Verdict = { raise: string } | 'clear' | 'unknown';

// The Service checks as the Hub stored them.
const StoredServicesSchema = z.array(
  z.object({
    check: z.enum(SERVICE_CHECK_KINDS),
    detail: z.string(),
    service: z.string(),
    since: z.number(),
    state: z.enum(SERVICE_CHECK_STATES),
  }),
);

const UnreadableRecordsSchema = z.array(z.object({ kind: z.string(), name: z.string() }));

type CheckSetRow = { services: unknown };
type RecordSetRow = { over_budget_bytes: string | null; unreadable: unknown };

// How the reason names a failing state. A health check will join as unhealthy.
const FAILING_STATES: Partial<Record<ServiceCheck['state'], string>> = { stopped: 'Stopped' };

// What one Service's checks say. It is down once any check has been failing for
// long enough, in the System's awake time; the reason names the first such
// check, supervisor before the rest. It is up, and its Condition clears, when
// every check that was made passes. Anything else, including a check that is
// unknown or failed only recently, or a Service with no check made, leaves the
// Condition as it is.
const verdictOf = (
  checks: readonly ServiceCheck[],
  failedLongEnough: (check: ServiceCheck) => boolean,
) => {
  const ordered = SERVICE_CHECK_KINDS.flatMap((kind) => checks.filter((c) => c.check === kind));
  for (const check of ordered) {
    const label = FAILING_STATES[check.state];
    if (label !== undefined && failedLongEnough(check)) {
      return { raise: `${label}: ${check.detail}.` } satisfies Verdict;
    }
  }
  const made = ordered.filter((c) => c.state !== 'unchecked');
  return made.length > 0 && made.every((c) => c.state === 'up') ? 'clear' : 'unknown';
};

// Raises and clears one System's Service down under the System's row lock, so
// it orders with its Reports (ADR-0005), at the time `clock` reads once the
// lock is held. It is one Condition per Service, whatever checks it has, with
// the Service's name as subject. Only a Service the Hub mirrors a record for is
// judged. The Condition is left as it is while the System's records are over
// budget or its checks have no services part, because the Collector sent none
// or sent it over budget, and for a Service with no readable check. A Service
// with no record left, which is how a forgotten record looks, is cleared, even
// while the services part is over budget, but not while any service record is
// unreadable, since that record may be the Service.
const evaluateSystem = (sql: SQL, system: string, clock: () => number) =>
  sql.begin(async (tx) => {
    const [held]: { name: string }[] = await tx`
      SELECT name FROM systems WHERE name = ${system} FOR UPDATE
    `;
    const now = clock();
    const [checkSet]: CheckSetRow[] = await tx`
      SELECT services FROM check_sets WHERE system = ${system}
    `;
    const [recordSet]: RecordSetRow[] = await tx`
      SELECT over_budget_bytes, unreadable FROM record_sets WHERE system = ${system}
    `;
    if (
      held === undefined ||
      checkSet === undefined ||
      recordSet === undefined ||
      recordSet.over_budget_bytes !== null
    ) {
      return;
    }
    const mirrored: { name: string }[] = await tx`
      SELECT name FROM mirrored_records WHERE system = ${system} AND kind = 'service'
    `;
    const open: { subject: string }[] = await tx`
      SELECT subject FROM conditions
      WHERE system = ${system} AND kind = ${SERVICE_DOWN} AND cleared_at IS NULL
    `;
    const unreadable = (UnreadableRecordsSchema.safeParse(recordSet.unreadable).data ?? []).some(
      (ref) => ref.kind === 'service',
    );
    // No services part, or one the Hub cannot read, judges no Service.
    const checks = StoredServicesSchema.safeParse(checkSet.services).data ?? [];
    // A check has failed for long enough once the System was awake for that
    // long since its `since`, counted in whole rollup buckets from the System's
    // Vitals through its latest sample. Both are on the System's clock, so
    // neither the Hub's clock nor the time the System spent silent or asleep
    // counts. The Hub's clock bounds nothing, since a System whose clock runs
    // ahead would then never be judged.
    const latest = await latestBucketOf(tx, system);
    const awakeCutoff =
      latest === undefined
        ? undefined
        : (await awakeCutoffOf(tx, { maxGraceMs: SERVICE_DOWN_AFTER_MS, system, through: latest }))(
            SERVICE_DOWN_AFTER_MS,
          );
    const failedLongEnough = (check: ServiceCheck) =>
      awakeCutoff !== undefined && check.since <= awakeCutoff;

    const verdicts = new Map<string, Verdict>();
    for (const { name } of mirrored) {
      verdicts.set(
        name,
        verdictOf(
          checks.filter((c) => c.service === name),
          failedLongEnough,
        ),
      );
    }
    // A Service no record names any more is cleared, which is how a forgotten
    // record clears its Service down.
    for (const { subject } of open) {
      if (!verdicts.has(subject)) {
        verdicts.set(subject, 'clear');
      }
    }

    const at = new Date(now);
    for (const [subject, verdict] of verdicts) {
      // An unreadable record may be any Service, so a forgotten one is not
      // cleared while one exists; a Service can still be raised or cleared on
      // its own checks.
      const forgotten = !mirrored.some((m) => m.name === subject);
      if (verdict === 'clear' && forgotten && unreadable) {
        continue;
      }
      if (verdict === 'clear') {
        // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
        await clear(tx, { kind: SERVICE_DOWN, now: at, subject, system });
      } else if (verdict !== 'unknown') {
        // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
        await raise(tx, { kind: SERVICE_DOWN, now: at, reason: verdict.raise, subject, system });
      }
    }
  });

// Raises and clears every System's Service down, judging each at the time
// `clock` (epoch milliseconds) reads once it holds that System's lock. `serve`
// runs it every minute. A System that cannot be judged does not stop the rest;
// one error then names each such System and why.
export const evaluateServiceConditions = async (sql: SQL, clock: () => number): Promise<void> => {
  const systems: { system: string }[] = await sql`SELECT system FROM check_sets ORDER BY system`;
  await evaluateEach(
    systems.map((row) => row.system),
    (system) => evaluateSystem(sql, system, clock),
  );
};
