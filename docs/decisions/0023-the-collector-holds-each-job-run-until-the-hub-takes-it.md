---
type: adr
title: ADR-0023 - The Collector holds each job run until the Hub takes it, and the Hub keeps 90 days of runs
description: "A Report gains a job runs section that carries every run the Collector keeps and the Hub has not taken, oldest first, as Service stops ride Reports. The Hub stores each run by System, job, and start, and keeps 90 days of them as each job's run history. Job Conditions are still judged from the latest runs section, which is unchanged."
status: accepted
created: 2026-11-14
modified: 2026-11-14
---

# The Collector holds each job run until the Hub takes it, and the Hub keeps 90 days of runs

## Context

A job reports each run to its Collector, which keeps the job's runs of the last 90 days, keyed by job and start time ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)).
A Report's runs section carries only each job's latest run and latest successful run, and the Hub replaces what it mirrors with each section.
The job Conditions need nothing more, but every other run is lost to the Hub: a job that runs twice between two Reports shows one run, and the runs made during a Hub outage collapse into the last one.
A page that shows each job's recent runs needs every run, with its start, finish, exit status, and output.

[ADR-0021](0021-the-collector-logs-service-stops-and-the-hub-raises-a-note.md) solved the same loss for Service stops: the Collector holds each stop until a Report carrying it is delivered, and the Hub keeps 90 days of them.

## Decision

**A Report gains a job runs section.**
It carries the runs the Collector keeps that the Hub has not taken, oldest first and at most 1,000 to a Report, each as the job recorded it, with its job's name.
A job and a start name a run, so a section holds each at most once.
The Collector sends the section while it holds any such run.
A delivered Report settles the runs it carried; a failed delivery keeps them, and a refused one keeps them and holds them back for an hour, as for Service stops.
A run recorded again with the same start, which replaces it at the Collector, is sent again.

**The Collector holds no second copy.**
Which runs the Hub has not taken is a mark on the runs the Collector already keeps, so the 90 days it keeps a run bound what it holds for the Hub.
Runs kept before the Collector sent the section count as not taken, so the Hub's history starts with the Collector's 90 days.
Forgetting a job removes its runs, taken or not.

**The Hub keeps 90 days of runs.**
It stores each run by System, job, and start, with the Report's `sentAt` and its own received time, and replaces a held run under the guard it uses for Service stops, so a re-sent run is stored once.
It prunes runs that started more than 90 days before its own clock.
Runs are evidence for the dashboard, apart from the records ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)).

**The latest runs stay as they are.**
The runs section, the Hub's mirror of it, the job Conditions judged from that mirror, and the records read are unchanged.

## Considered options

- **The Hub builds the history from each runs section.** Rejected: the section is latest-only, so runs between Reports and during a delivery gap are lost.
- **Replace the runs section with the log, and judge job Conditions from the history.** Rejected: the Collector keeps a job's latest success past 90 days, which the history would prune, and Hubs that predate the log, and provisioners through the records read, rely on the latest runs as they are.
- **Send every kept run with each runs section.** Rejected: a job that runs each minute keeps about 130,000 runs, far beyond a Report.
- **A log of its own with a smaller bound, as Service stops keep 1,000 per Service for 7 days.** Rejected: the Collector already keeps 90 days of runs, which matches what the Hub keeps.

## Consequences

- A Report gains a section, additively ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)). A Hub that predates it drops the section and still takes the Report, and the Collector settles those runs, so they never reach the history: the Hub is upgraded before its Collectors.
- A Collector's first Reports after it gains the section carry its whole 90 days of runs, 1,000 to a Report.
- A job that runs weekly or less often has at most 13 runs in the history.
- Run times are on the System's clock and pruning is on the Hub's, so a System whose clock runs behind loses its runs a little early.
