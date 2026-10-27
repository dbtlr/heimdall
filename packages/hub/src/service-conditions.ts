import { SERVICE_CHECK_KINDS, SERVICE_CHECK_STATES } from '@heimdall/schema';
import type { ServiceCheck, ConditionKind } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

import { sampleCutoffOf } from './awake-time.ts';
import { clear, evaluateEach, raise } from './conditions.ts';

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

// How the reason names a failing state.
const FAILING_STATES: Partial<Record<ServiceCheck['state'], string>> = {
  stopped: 'Stopped',
  unhealthy: 'Unhealthy',
};

// What one Service's checks say. It is down once any check has been failing for
// long enough, in the System's awake time; the reason names the first such
// check in the order of the check kinds, supervisor before health. It is up, and its Condition clears, when
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

// What one System's Service down is judged on, as read under its row lock.
export type ServiceDownFacts = {
  // The checks of the services part, none when the Collector sent none or one
  // the Hub cannot read.
  checks: readonly ServiceCheck[];
  // The Services the Hub mirrors a record for.
  mirrored: readonly string[];
  // The Services whose Service down is open.
  open: readonly string[];
  // Whether the System's records are over budget, so the Hub cannot tell which
  // Services it has.
  recordsOverBudget: boolean;
  // The System-clock time with 2 minutes of awake samples after it, or
  // undefined while the System has taken fewer.
  sampleCutoff: number | undefined;
  // Whether any service record is unreadable.
  unreadable: boolean;
};

// Judges one System's Service down: for each Service, whether to raise its
// Condition with a reason (or update the open one's reason) or clear it. A
// Service left out stays as it is. It is one Condition per Service, whatever
// checks it has. Only a Service the Hub mirrors a record for is judged, and
// nothing is while the records are over budget. A check has failed for long
// enough once the System took samples for that long since its `since`, 15
// seconds each; both are on the System's clock, so neither the Hub's clock nor
// the time the System spent silent or asleep counts, and a System whose clock
// runs ahead is still judged. A Service with no record left, which is how a
// forgotten record looks, is cleared, even while the services part is over
// budget, but not while any service record is unreadable, since that record
// may be the Service.
export const judgeServiceDown = (
  facts: ServiceDownFacts,
): Map<string, Exclude<Verdict, 'unknown'>> => {
  const judged = new Map<string, Exclude<Verdict, 'unknown'>>();
  if (facts.recordsOverBudget) {
    return judged;
  }
  const { sampleCutoff } = facts;
  const failedLongEnough = (check: ServiceCheck) =>
    sampleCutoff !== undefined && check.since < sampleCutoff;
  for (const name of facts.mirrored) {
    const verdict = verdictOf(
      facts.checks.filter((c) => c.service === name),
      failedLongEnough,
    );
    if (verdict !== 'unknown') {
      judged.set(name, verdict);
    }
  }
  for (const subject of facts.open) {
    if (!facts.mirrored.includes(subject) && !facts.unreadable) {
      judged.set(subject, 'clear');
    }
  }
  return judged;
};

// Raises and clears one System's Service down under the System's row lock, so
// it orders with its Reports (ADR-0005), at the time `clock` reads once the
// lock is held, with the Service's name as subject. The Condition is left as
// it is while the System has no checks or records stored.
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
    if (held === undefined || checkSet === undefined || recordSet === undefined) {
      return;
    }
    const mirrored: { name: string }[] = await tx`
      SELECT name FROM mirrored_records WHERE system = ${system} AND kind = 'service'
    `;
    const open: { subject: string }[] = await tx`
      SELECT subject FROM conditions
      WHERE system = ${system} AND kind = ${SERVICE_DOWN} AND cleared_at IS NULL
    `;
    const judged = judgeServiceDown({
      checks: StoredServicesSchema.safeParse(checkSet.services).data ?? [],
      mirrored: mirrored.map((row) => row.name),
      open: open.map((row) => row.subject),
      recordsOverBudget: recordSet.over_budget_bytes !== null,
      sampleCutoff: await sampleCutoffOf(tx, { spanMs: SERVICE_DOWN_AFTER_MS, system }),
      unreadable: (UnreadableRecordsSchema.safeParse(recordSet.unreadable).data ?? []).some(
        (ref) => ref.kind === 'service',
      ),
    });

    const at = new Date(now);
    for (const [subject, verdict] of judged) {
      if (verdict === 'clear') {
        // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
        await clear(tx, { kind: SERVICE_DOWN, now: at, subject, system });
      } else {
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
