---
type: adr
title: ADR-0021 - The Collector logs Service stops from supervisor facts, and the Hub raises a note
description: "At each Service check the Collector compares the supervisor's own facts with a baseline it keeps per Service and per boot, and logs each stop it finds. The log rides Reports until the Hub settles it, so a stop survives recovery, network gaps, and Collector restarts. The Hub keeps stops for 90 days and raises one note-level Service restarted Condition per Service, cleared after 24 hours with no new stop."
status: accepted
created: 2026-10-24
modified: 2026-10-24
---

# The Collector logs Service stops from supervisor facts, and the Hub raises a note

## Context

The Collector checks each recorded Service every 60 seconds and reports only its current state and `since`.
The Hub keeps only the latest checks and raises Service down once a check has failed for two minutes of the System's awake time.
A stop shorter than that leaves nothing: one check sees it, the next overwrites it, and a stop shorter than a minute can fall between two checks.
A Report's checks section is latest-only, so a Service that recovers before a delayed delivery loses its failure too.

Supervisors already hold what a poll misses.
systemd keeps the enter and exit timestamps of a unit's states, an automatic-restart count, and the result and exit status of its last run.
Docker keeps a container's start and finish times, restart count, and exit code.
launchd keeps a run count and the last exit code or signal, without times.

[ADR-0017](0017-the-hub-sets-condition-levels.md) has the Hub set every Condition's level from what Collectors observe.
The glossary defines a Condition as a current state and the Timeline as the history of Conditions, so a stop that already recovered is neither on its own.

## Decision

**The Collector logs stops.**
At each Service check the Collector also reads the supervisor's facts and compares them with a baseline it stores per Service in its own state, together with the boot the facts came from.
Each stop it finds becomes one log entry: when the stop began and ended, as precisely as the supervisor knows, the result and exit status, and the change in the restart count.
A check writes at most one entry per Service, so a restart storm is one entry with its count, never one entry per restart.
The log rides Reports as pending data until the Hub settles it, as job runs do, and keeps at most 7 days or 1,000 entries per Service.
A stop is an observation of the supervisor, not a judgment, so the Hub still sets every level.

**Only what the supervisor shows is a stop.**
Any stop counts, deliberate or not: a deploy, an upgrade, a stop forced by a dependency, and a stop long enough to raise Service down.
A new boot starts a fresh baseline, so a reboot is not a stop of every Service; a Service that does not come back raises Service down as before.
A restart count lower than the baseline, as after `systemctl reset-failed`, becomes the new baseline, and the timestamps still decide whether a stop happened.
A Collector restart within one boot compares against the stored baseline, so a stop during the gap is still found.
A check that cannot reach the supervisor infers nothing and leaves the baseline as it is.
A health URL is sampled, not held by a supervisor, so health failures and `none` Services never log a stop.

**The Hub raises one note per Service.**
The Hub keeps the stops it receives for 90 days and raises a Service restarted Condition, with the Service as subject, at the note level.
Each further stop updates the open Condition: its reason gives the count, the first and last stop, and the latest result, telling a clean stop from a failure.
It clears after a fixed 24 hours with no new stop.
It never steps up, whatever the count, so it is never delivered ([ADR-0020](0020-the-hub-delivers-alerts-through-ntfy.md)), and Service down's threshold is unchanged.
The Timeline shows the Condition as it shows any other; stops are evidence behind it, read on the Service's page and through the dashboard's read API, apart from the records ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)).

The evidence of why a Service stopped, such as a provisioner's own health events, is not covered here.

## Consequences

- A Report gains a section, additively ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)).
- Every deliberate restart of a recorded Service leaves a note for a day, the Hub's own Service on each rollout included.
- Two clean stops of a systemd unit within one check read as one, since systemd counts only automatic restarts.
- systemd forgets a unit's result and exit status when it starts again, so a stop that begins and ends between two checks carries neither, and its note cannot tell a clean stop from a failure.
- A launchd stop is timed only to the minute between two checks.

## Considered options

- **The Hub derives stops from the latest facts in each Report.** Rejected: the checks section is latest-only, so stops during a delivery gap collapse into the last one.
- **Log every stopped check at the Hub.** Rejected: it misses stops shorter than a check and loses those during a delivery gap.
- **A stop record on the Timeline, beside Conditions.** Rejected: it widens the Timeline beyond Conditions and puts nothing in front of the operator.
- **Count only failures.** Rejected: a stop forced by a failing dependency reads as a clean stop on the Service's own unit.
- **Count a reboot as a stop of every Service.** Rejected: one cause would raise one note per Service.
- **Count health-URL blips.** Rejected: one slow answer would raise a day-long note.
- **Return stops with the records.** Rejected: it mixes what Heimdall observed into what the provisioner recorded.
- **Collect cause evidence from journals.** Rejected for now: the Collector would read a provisioner's own output, and a provisioner can push its evidence through `record` instead.
