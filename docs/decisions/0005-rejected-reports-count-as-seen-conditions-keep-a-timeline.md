---
type: adr
title: ADR-0005 - A rejected Report still counts as seeing its System, and Conditions keep a Timeline
description: "Last seen moves on every request whose token names a System, whether the Hub stores or rejects the Report. A rejection raises that System's Reports-rejected Condition; each Condition records when it was raised and cleared, and those records form the System's Timeline."
status: accepted
created: 2026-10-06
modified: 2026-10-09
---

# A rejected Report still counts as seeing its System, and Conditions keep a Timeline

## Context

The Hub answers an invalid Report with 422, and the Collector drops it ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)).
A Collector released ahead of the Hub with a new `schemaVersion` gets 422 on every Report, and a Collector with a mismatched `system` setting gets 403 on every Report, yet both prove through their token which System they run on.
If last seen moved only when a Report was stored, the page would show such a System as quiet, which is indistinguishable from a System that is asleep, and M3's stale-System Condition would name the wrong cause.
A dropped Report is lost for good, so a single bad batch between good ones must stay visible after the Collector recovers.

## Decision

**Last seen counts every attributable Report.** A System is seen whenever the Hub receives a request carrying that System's token, whether it stores the Report or rejects it with 422 or with 403 for naming another System. The time is credited to the token's System, never to the System the body names. A request with no token or a token no System holds is not attributable and counts for nothing.

**A rejection raises the Reports-rejected Condition.** The Condition carries the reason the Hub answered with. While it stays raised, each further rejection replaces its latest reason, in the order the Hub receives them, and adds nothing else. The next Report the Hub accepts from the System clears it, even one whose samples the Hub already held. The Hub gives the same answer whether or not it could record the rejection.

**Conditions keep their history, and the history is the Timeline.** Each Condition records when it was raised, with its reason, and when it was cleared, never earlier than it was raised. A System holds at most one open Condition of each kind and subject; the subject names what a Condition is about, such as a Service, and is empty for one about the System itself. A System's Timeline lists those transitions with each Condition's lines together, the most recently raised Condition first in the order the Hub received them, so a step back in the Hub's clock cannot hide or reorder one. The page shows each System's current status from all of its open Conditions, and its Timeline shows its latest Conditions, where it failed and when it recovered. Conditions that M3 derives (Service down, Backup Job overdue, Drift, stale System) record their transitions the same way and appear on the same Timeline.

## Considered options

- Last seen only on a stored Report. Rejected: an awake System that the Hub rejects looks the same as one that is asleep.
- Show any rejection from the last 24 hours on the page. Rejected in favour of a current status plus a Timeline: the page stays truthful about now, and the Timeline keeps the record for as long as needed.
- Log every rejection. Rejected: a Collector retries every few seconds to minutes, and the Timeline would flood. Only transitions are recorded.
- A separate log for ingest failures. Rejected: M3's Conditions need a history too, and one mechanism serves both.

## Consequences

A System can appear on the page before any of its Reports is stored, with a last-seen time and a status but no Vitals or Collector build.
Going quiet, including sleep, adds nothing to the Timeline until M3's stale-System Condition, which the Hub must evaluate on a timer rather than on a request.

## Changelog

- 2026-10-08: Clarification. Under [ADR-0011](0011-collectors-hold-what-provisioners-record.md), Backup Job overdue becomes job overdue or failing, for any job a provisioner records. The decision is unchanged.
- 2026-10-09: Clarification. A transcript upload under a System's token also counts toward its Last seen, and a refused upload does not raise Reports rejected ([ADR-0013](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)). The decision is unchanged.
- 2026-10-10: Clarification. The dashboard's normal view lists only paired Systems; an unpaired System's status, with the Conditions still open on it, shows in the unpaired view, and its Timeline is kept. The decision is unchanged.
