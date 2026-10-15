---
type: adr
title: ADR-0017 - The Hub sets each Condition's level
description: "Every Condition carries a Hub-set level: note, warning, or alert. Levels can change without replacing the Condition, and the Timeline records those changes, superseding ADR-0005's raised-and-cleared-only history. A System's health is its worst open level, with limits in Hub configuration and per-System overrides, and no muting."
status: accepted
created: 2026-10-15
modified: 2026-10-15
---

# The Hub sets each Condition's level

## Context

The Hub derives Conditions, but the dashboard assigns each kind a fixed severity in `packages/dashboard/src/lib/conditions.ts`.
That table cannot distinguish a disk that is filling from one that is nearly full.
Other readers would have to copy the table to reach the same verdict.

[M7](../roadmap.md#m7-system-health) makes System health the dashboard's starting point.
Health needs one definition, and a problem's urgency can change while the problem stays open.
[ADR-0005](0005-rejected-reports-count-as-seen-conditions-keep-a-timeline.md) preserves a Condition's identity and its raised and cleared history.
It does not yet account for level changes.

## Decision

**Every Condition carries a level set by the Hub**, ordered from least to most urgent:

- **note**: something to know about, with no action required now.
- **warning**: something to act on this week.
- **alert**: something to act on now.

The Hub derives the level alongside the Condition from the evidence it holds.
Collectors report observations, not levels.
The dashboard reads the stored level instead of assigning severity by kind, as do any later readers or delivery channels.
An alert is a level, not a delivered notification. Delivery remains a later milestone.

**Limits belong in Hub configuration**, in `hub.toml` or its JSON equivalent, following [ADR-0007](0007-binaries-own-their-service-config-file-holds-settings.md).
Defaults for the fleet apply unless a per-System override replaces a limit; limits without an override keep their default.
The Hub uses those limits for graded Conditions and assigns fixed levels to kinds whose urgency does not depend on a measurement.
M7 starts with Drift and job overdue at warning, and Service down, stale System, job failing, and Reports rejected at alert.
Those kinds' levels are fixed, not configurable; changing measurement limits does not lower them.
They clear under their existing rules, such as a Service recovering or its provisioner's record being removed.
Disk starts at note at 70% used, warning at 80%, and alert at 90%, with hysteresis when stepping down.
Configuration syntax and the precise hysteresis rules belong to HMD-109.

**A level change keeps the same open Condition.** The identity remains System, kind, and subject, with at most one open Condition for that identity.
The level is not part of the identity.
A Condition occurrence is one span from raising to clearing; a later recurrence is a separate occurrence of the same identity.
A disk moving from note to warning to alert remains one occurrence, with its original raised time.
Stepping down to note keeps it open.
Clearing ends the occurrence, whether on recovery or another clearing rule, such as its subject being removed.
A later recurrence starts a new occurrence.

**The Timeline records raised, level-changed, and cleared transitions.** Raising records the initial level and reason.
Each level change records the previous and new levels, the reason, and when the Hub made the change.
Clearing preserves the last level and ends the occurrence.
The Hub stores the current level and its transition in the same transaction, so readers cannot see one without the other.
An observation that changes only the latest reason adds no Timeline transition, as in ADR-0005.

The Timeline keeps each occurrence's lines together, with the most recently raised occurrence first.
Transitions within an occurrence follow the Hub's recording order, even if its clock steps back.
Each recorded transition time is no earlier than the preceding transition in that occurrence, including clearing after a level change.
Changing a level does not move the occurrence ahead of one raised later.
This decision supersedes ADR-0005's raised-and-cleared-only history; the rest of that decision holds.

**A System's health is its worst open level**, never a score or a count of Conditions.
An alert outweighs any number of warnings or notes; a warning outweighs any number of notes.
Notes alone leave the System healthy, with the notes visible.
With no open Conditions, there is no Condition-derived problem; that is not proof that every check has run or every observation is current.
Evidence freshness and coverage remain separate facts, and old or unknown evidence does not lower an open Condition's level.

**There is no muting, acknowledgement, or snooze.** Open Conditions keep contributing their levels to System health.
Hub limits, including per-System overrides, are the escape hatch for measurements whose defaults do not fit a System.
Tuning a limit changes subsequent judgments, not recorded history.
The roadmap's later delivery silencing concerns notifications, not hiding Conditions or removing their contribution to health.

## Considered options

- **Keep severity in the dashboard.** Rejected: each reader would own its own verdict, and fixed severity by kind cannot express graded disk usage.
- **Clear and raise when a level changes.** Rejected: one continuing problem would appear as repeated failures and recoveries, losing its original start.
- **Compute health as a score.** Rejected: several notes could make a healthy System look unhealthy, or a score could hide one urgent problem.
- **Mute an inconvenient Condition.** Rejected: hiding a problem would detach health from the Hub's judgment. Limits make that judgment explicit instead.

## Consequences

This ADR establishes the M7 contract ahead of implementation.
HMD-109 adds stored levels and transitions, Hub limits, graded disk judgments, and dashboard readers in one change, consistent with [ADR-0015](0015-dashboard-is-its-own-app-reading-the-hubs-database.md).
Until then, the runtime still uses the dashboard's severity table and the raised-and-cleared history described in the [spec](../spec.md).

HMD-109 must settle migration of existing `low_disk` occurrences and their history before changing the kind or subject that identifies them.
Existing history has no recorded levels; migration must distinguish a backfilled level from an observed transition rather than inventing past level changes.
The configuration shape, migration schema, and dashboard layout are not prescribed here.
