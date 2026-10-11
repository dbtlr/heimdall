---
type: adr
title: ADR-0013 - Transcripts upload as acknowledged chunks into PostgreSQL, from sources each System opts into
description: "A System captures transcripts only from the sources its Collector configuration lists, each a Harness with an optional directory and name. The Collector uploads each file of a Harness's session tree as gzipped chunks; the Hub checks the offset, stores the chunk in PostgreSQL, and acknowledges it in one transaction. The Collector spools what the Hub has not acknowledged, without a size limit, and nothing expires on the Hub until it is deleted on purpose."
status: accepted
created: 2026-10-09
modified: 2026-10-11
---

# Transcripts upload as acknowledged chunks into PostgreSQL, from sources each System opts into

## Context

[ADR-0012](0012-hub-archives-agent-session-transcripts.md) makes the Hub the durable archive of agent Session transcripts and leaves the capture design open: which files, how they travel, where they are stored, and how capture is turned on.

The Harnesses Heimdall supports first write their transcripts as JSONL files that only grow:

- Claude Code writes `<config dir>/projects/<project>/<session>.jsonl`, with subagent and workflow transcripts, small `.meta.json` files, and large tool outputs in `tool-results/` beside it. Subagent transcripts are about three quarters of its volume. It deletes old files after 30 days by default.
- Codex writes `<home>/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl`. A forked Session's file repeats its parent's history.
- Either Harness can be pointed at another directory, so one System can hold several profiles of the same Harness.

One busy System writes about 80 MB of transcripts a day, which gzip shrinks four to five times: several gigabytes a year.

## Decision

- **A System captures only the sources its Collector configuration lists.** Each source names a Harness, and optionally a directory, defaulting to the Harness's standard location, and a name, defaulting to the Harness's name. With no sources listed, capture is off, which is the default. The Collector refuses a configuration where two sources share a name or resolve to the same directory. A source whose directory does not exist is reported as absent and skipped, so one rendered list can serve Systems that run different Harnesses. The Collector reads each directory as its own account and reports its whole set of sources, each as capturing, absent, or unreadable, in its Reports whenever the set changes, as it does its records ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)).
- **A source's whole session tree is captured,** including what is already there when the source is added. For Claude Code, every file under `projects/`; for Codex, every file under `sessions/`. Prompt history, shell snapshots, per-Session environment directories, and Codex's SQLite stores are not.
- **The Hub numbers each file's generations.** A generation is one continuous run of a file's content. The Collector opens a generation for a file it has not uploaded before, and the Hub returns its identifier; every chunk names it. The Collector opens a new generation, never appending to the old one, when the file shrinks, its identity on disk changes, the bytes it already uploaded no longer match the file, the Hub holds more of the generation than the file now has, or the Collector has no record of the file, as after its state directory is wiped. Content can then be stored twice, but never spliced from two different files.
- **The Collector uploads gzipped chunks**, one per request to the Hub's transcript endpoint, authenticated with the System's token. A chunk of a JSONL file ends on a line boundary unless one line is longer than the chunk limit, which is split. A file that is not JSONL uploads whole, in chunks within the limit, after it is unchanged across two scans, and a later change to it opens a new generation. The chunk limit is below the Hub's request cap, so the Hub never refuses a chunk for its size.
- **The Hub acknowledges a chunk in the same transaction that stores it.** It accepts a chunk only at the offset it already holds for that generation, stores it in PostgreSQL, and answers with the new total. A chunk at any other offset is answered with what the Hub holds, and the Collector resumes from there; a chunk it already holds is accepted again without effect. A chunk or a new generation for a path deleted on purpose is refused as deleted, and the Collector stops uploading that path; this is the one refusal the Collector drops, because it acknowledges a deliberate delete. An upload counts toward the System's Last seen; a refused upload does not raise the Reports rejected Condition.
- **The Collector spools what the Hub has not acknowledged.** It writes new content to a spool in its state directory before it counts that content as read, and removes each chunk once acknowledged, so a Harness deleting a file loses nothing. A source removed from the configuration has its spooled content uploaded, then nothing more. The spool has no size limit; `service status` shows its size and the age of its oldest content, the Collector reports both with its sources, and it warns when it holds content spooled more than a day ago.
- **The Hub keeps transcripts as written until they are deleted on purpose.** Generations are keyed by System, source name, path within the source, and generation identifier. Chunks are stored compressed, as uploaded. `heimdall-hub transcripts delete` removes whole generations: those of a System, of a source, or those whose last upload was before a date, so a file still growing is never cut. Once every generation at a path is deleted, the Hub remembers the path and refuses any later generation at it, so a deleted file is not uploaded again even after the Collector's state is wiped; a path with a surviving generation keeps uploading. Repeated history across files, and every Harness's format, are left as written for later analysis.

## Considered options

- Compressed files on the Hub's disk with an index in PostgreSQL. Rejected: it adds a second store to back up and a gap between storing and acknowledging that the code must close. At several gigabytes a year, PostgreSQL holds the archive comfortably.
- Capture on unless turned off. Rejected: a newly paired System would archive every prompt and tool output before anyone chose it.
- Main Session transcripts only. Rejected: it loses subagent spend and any large tool output once the Harness prunes it.
- A capped spool that drops the oldest content. Rejected: an outage longer than the cap would silently lose part of the archive.

## Consequences

The Hub's database, and the backups of it, grow by several gigabytes a year for each busy System.
A forgotten System captures nothing; the Hub can show which Systems capture which sources.
During a long Hub outage, a busy System's spool grows by tens of megabytes a day.
A provisioner that renders one configuration for every System can list every source any System uses; a System where a source is absent skips it. Capturing a source on one System but not another needs a per-System configuration, as [ADR-0009](0009-collectors-pair-with-the-hub.md)'s clarification anticipates.
Enabling a source uploads the history already on disk, so the first upload after enabling it is large.
A Session resumed after its whole transcript was deleted is not captured again, because its path stays refused.
A Harness that changes where or how it writes transcripts needs a Collector release before its new files are captured.

## Changelog

- 2026-10-09: Clarification. Every Report carries the Collector's whole set of sources and its spool's size and age, not only Reports sent when the set changes, because the spool changes with every acknowledged chunk. A Collector that captures nothing reports no sources and an empty spool. The decision is unchanged.
- 2026-10-11: Clarification. Deleting generations also removes the Session facts derived from them, re-deriving any that another generation still holds ([ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)), so nothing derived outlives its transcript. The decision is unchanged.
