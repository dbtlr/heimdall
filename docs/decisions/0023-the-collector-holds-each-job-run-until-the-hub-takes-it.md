---
type: adr
title: ADR-0023 - The Collector holds each job run until the Hub takes it, and the Hub keeps each job's run history
description: "A Report gains a job runs section that carries every run the Collector keeps and the Hub has not taken, oldest first, as Service stops ride Reports. The Hub stores each run by System, job, and start, and keeps 90 days of runs and each job's latest 14 however old as its run history. Job Conditions are still judged from the latest runs section, which is unchanged."
status: accepted
created: 2026-11-14
modified: 2026-11-14
---

# The Collector holds each job run until the Hub takes it, and the Hub keeps each job's run history

## Context

A job reports each run to its Collector, which keeps the job's runs of the last 90 days, keyed by job and start time ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)).
A Report's runs section carries only each job's latest run and latest successful run, and the Hub replaces what it mirrors with each section.
The job Conditions need nothing more, but every other run is lost to the Hub: a job that runs twice between two Reports shows one run, and the runs made during a Hub outage collapse into the last one.
A page that shows each job's last 14 runs needs every run, with its start, finish, exit status, and output.

[ADR-0021](0021-the-collector-logs-service-stops-and-the-hub-raises-a-note.md) solved the same loss for Service stops: the Collector holds each stop until a Report carrying it is delivered, and the Hub keeps 90 days of them.

## Decision

**A Report gains a job runs section.**
It carries the runs the Collector keeps that the Hub has not taken, oldest first and at most 1,000 to a Report, each as the job recorded it, with its job's name.
A job and a start name a run, so a section holds each at most once.
The Collector sends the section while it holds any such run.
A delivered Report settles the runs it carried; a failed delivery keeps them, and a refused one keeps them and holds them back for an hour, as for Service stops.
A run recorded again with the same start, which replaces it at the Collector, is sent again, even when that happens after the Collector read the run for a section and before the Report carrying it was delivered: each held run counts its changes, as each logged Service stop does, and a delivered Report settles a run only if its count is still the one read for the section.
A run the section cannot carry, which only a damaged state file holds, is left out and no longer held, with one warning, so it never holds back the runs after it or a Report.

**The Collector holds no second copy.**
Which runs the Hub has not taken is a mark on the runs the Collector already keeps, so the 90 days it keeps a run bound what it holds for the Hub.
Finding the marked runs is an index lookup over them alone, so its cost does not grow with the runs already taken.
Runs kept before the Collector sent the section count as not taken, so the Hub's history starts with the Collector's 90 days.
Pairing marks every kept run as not taken again, so a Hub the Collector pairs with, new or the same, gets every run the Collector still keeps.
Pairing counts as a change to each run, so a Report read before it settles none of them, and a running Collector whose identity `pair` replaced sends no job runs until it restarts, so the Hub it started with never takes the runs held for the next.
Forgetting a job removes its runs, taken or not.

**The Hub keeps 90 days of runs, and each job's latest 14.**
It stores each run by System, job, and start, with the Report's `sentAt` and its own received time, and replaces a held run under the guard it uses for Service stops, so a re-sent run is stored once.
It stores every time the section accepts, so a run from a broken clock never fails a Report.
It prunes runs that started more than 90 days before its own clock, except each job's latest 14 runs, so a job that runs weekly or monthly still shows its last 14.
Runs are evidence for the dashboard, apart from the records ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)).

**The latest runs stay as they are.**
The runs section, the Hub's mirror of it, the job Conditions judged from that mirror, and the records read are unchanged.
The mirror stays the source of each job's latest run and status; the history is the list of earlier runs, and the two can differ, as the spec describes.

## Considered options

- **The Hub builds the history from each runs section.** Rejected: the section is latest-only, so runs between Reports and during a delivery gap are lost.
- **Replace the runs section with the log, and judge job Conditions from the history.** Rejected: the Collector keeps a job's latest success past 90 days, which the history may prune, and Hubs that predate the log, and provisioners through the records read, rely on the latest runs as they are.
- **Send every kept run with each runs section.** Rejected: a job that runs each minute keeps about 130,000 runs, far beyond a Report.
- **A log of its own with a smaller bound, as Service stops keep 1,000 per Service for 7 days.** Rejected: the Collector already keeps 90 days of runs, which matches what the Hub keeps.
- **The Hub keeps 90 days and nothing older.** Rejected: a weekly job would show at most 13 runs and a monthly one about 3, short of the 14 the Jobs page shows.
- **Send every kept run again each hour, as the runs section refreshes, so a Hub restored from a backup gets its runs back.** Rejected for the same size as sending them with each runs section; pairing again backfills instead.

## Consequences

- A Report gains a section, additively ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)). A Hub that predates it drops the section and still takes the Report, and the Collector settles those runs, so they never reach the history: the Hub is upgraded before its Collectors.
- A Collector's first Reports after it gains the section, and after each pairing, carry its whole 90 days of runs, 1,000 to a Report.
- A Hub restored from a backup lacks the runs it took after that backup until the Collector is paired with it again; the latest runs come back with the next hourly runs section.
- A job's latest 14 runs stay at the Hub after the job is forgotten, until its System is purged.
- The history holds a run older than 90 days only once the Hub has taken it, so a monthly job shows the 3 or so runs its Collector keeps at first, and reaches 14 over the months that follow.
- Run times are on the System's clock and pruning is on the Hub's, so a System whose clock runs behind loses its runs a little early.
