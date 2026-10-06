---
type: adr
title: ADR-0008 - Vitals roll up into 5-minute buckets as they arrive, and serve prunes on a timer
description: "The Hub upserts each stored sample into its 5-minute rollup in the same transaction, so late and resent samples roll up correctly with no rollup job. A timer inside serve deletes raw samples after 14 days and rollups after a year."
status: proposed
created: 2026-10-06
modified: 2026-10-06
---

# Vitals roll up into 5-minute buckets as they arrive, and serve prunes on a timer

## Context

The Hub keeps raw Vitals samples for 14 days and 5-minute min/avg/max rollups for a year.
Samples do not arrive in order. A Collector that is awake but offline queues about 24 hours of samples and flushes them on reconnect, and an interrupted flush resends samples the Hub already holds, which the Hub skips by System and time ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)).
Fleet declares the Hub as one native Service ([ADR-0007](0007-binaries-own-their-service-config-file-holds-settings.md)).

## Decision

- **Rollups update at ingest.** In the transaction that stores a Report's samples, the Hub upserts each sample's 5-minute bucket for its System, keeping min, max, sum, and count per rolled-up Vital. Average is sum over count. Only the rows the insert actually stored roll up, so a resent sample never counts twice, and a late sample lands in its own bucket whenever it arrives.
- **`serve` prunes on a timer.** About once an hour, `serve` deletes raw samples older than 14 days and rollups older than a year. Pruning runs only while the Hub runs, with no separate unit or command for Fleet to schedule.

## Considered options

- A rollup job over closed buckets. Rejected: a sample arriving after its bucket closed would be missed unless the job rebuilt recent buckets, and the rollup could disagree with the raw rows it came from.
- A `prune` command run by a systemd timer that Fleet declares. Rejected: a second scheduled unit to declare and keep in step with the Hub, for work the running Hub can do itself.

## Consequences

Ingest does a little more work per sample, one upsert per bucket a Report touches.
A Hub that stays down keeps old rows until it runs again, which costs disk only.
A sample older than 14 days still rolls up when it arrives, and the next prune removes its raw row.
