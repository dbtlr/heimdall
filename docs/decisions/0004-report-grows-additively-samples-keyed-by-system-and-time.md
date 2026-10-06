---
type: adr
title: ADR-0004 - The Report grows additively, and samples are keyed by System and time
description: "Report schema versions bump only on breaking changes; the Hub drops unknown fields. Samples are deduplicated by System and timestamp. An invalid Report is answered 422 and dropped; every other failed delivery is retried."
status: accepted
created: 2026-10-05
modified: 2026-10-06
---

# The Report grows additively, and samples are keyed by System and time

## Context

The Report is the wire contract between every Collector and the Hub, defined once in `packages/schema` ([ADR-0003](0003-typescript-on-bun-for-collector-and-hub.md)).
Later milestones add sections to it: Inventory state in M3 and Sessions in M4.
Fleet rolls out Collector and Hub releases separately, and a sleeping System can miss a rollout, so the Hub cannot assume every Collector speaks its exact schema.
A Collector that is awake but offline queues about 24 hours of samples and flushes them on reconnect, so the Hub receives the same samples more than once when a flush is interrupted after the Hub stored a batch.
Zod accepts or rejects a Report as a whole.

## Decision

**The schema grows additively within a version.** New sections and fields are optional additions that keep `schemaVersion`. The Hub drops fields it does not know instead of rejecting the Report. `schemaVersion` bumps only on a rename, a removal, or a change of meaning, and the Hub rejects versions it does not know.

**Samples are keyed by System and time.** A Vitals sample is identified by the Report's `system` and the sample's `t`. Sample times strictly increase within a Report, and the Hub skips samples it already holds. Reports carry no ID of their own, so the Collector may regroup queued samples into batches of any size up to 1,000 samples.

**An invalid Report is dropped; every other failed delivery is retried.** The Hub answers 422 exactly when the Report itself is invalid: it fails the schema, carries an unknown `schemaVersion`, or exceeds the size cap. On 2xx the Report is delivered. On 422 the Collector drops the Report and logs it. Any other failed answer, including 401, 403, 429, and 5xx, and any network failure leave the Report queued for retry, bounded by the queue's size. A token that is wrong or names another System is a 403, so its Reports survive until the token is fixed. Validation rejects only broken structure, values that indicate a Collector bug (negative or non-finite numbers, fractional byte counts, out-of-order times), and Reports over the size cap. It tolerates values operating systems produce in normal operation: memory or disk used above total, percentages above 100, and sample times later than `sentAt`.

## Considered options

- Reject unknown fields and bump the version for every addition. Rejected: every rollout would require the Hub first, and a Collector released ahead of it would lose all its Reports instead of one new section.
- One ID per Report for deduplication. Rejected: it breaks when the Collector regroups its queue, and samples already carry a natural key.
- Drop on any 4xx. Rejected: a misrendered token would answer 401 and discard the whole queue, though fixing the token would have saved it.
- Accept the valid samples of a partly invalid Report. Rejected for v1: it needs a per-sample result in the response and more queue logic, while whole-Report rejection with lenient checks loses little.

## Consequences

A Collector newer than the Hub has its new sections silently dropped until the Hub is upgraded.
A breaking change is the exception: a Hub that does not know a Collector's `schemaVersion` answers 422 to all of its Reports and the Collector drops them, so the Hub must accept the new version before any Collector sends it.
Each later section needs its own natural key so the Hub can deduplicate it the same way.
A Collector bug that produces an invalid sample loses that whole Report, at most 1,000 samples.

## Changelog

- 2026-10-06: Addendum. A Report the Hub rejects with 422, or with 403 for naming another System, still counts as seeing the System its token names and raises that System's Reports-rejected Condition; see [ADR-0005](0005-rejected-reports-count-as-seen-conditions-keep-a-timeline.md). The answers and the Collector's handling of them are unchanged.
