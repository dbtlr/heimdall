---
type: adr
title: ADR-0013 - Transcripts upload as acknowledged chunks into PostgreSQL, from sources each System opts into
description: "A System captures transcripts only from the sources its Collector configuration lists, each a Harness with an optional directory and name. The Collector uploads each file of a Harness's session tree as gzipped chunks; the Hub checks the offset, stores the chunk in PostgreSQL, and acknowledges it in one transaction. The Collector spools what the Hub has not acknowledged, without a size limit, and nothing expires on the Hub until it is deleted on purpose."
status: accepted
created: 2026-10-09
modified: 2026-10-09
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

- **A System captures only the sources its Collector configuration lists.** Each source names a Harness, and optionally a directory, defaulting to the Harness's standard location, and a name, defaulting to the Harness's name. Names are unique on a System. With no sources listed, capture is off, which is the default. The Collector reads each directory as its own account and reports its sources, and whether each is readable, in its Reports.
- **A source's whole session tree is captured.** For Claude Code, every file under `projects/`; for Codex, every file under `sessions/`. Prompt history, shell snapshots, per-Session environment directories, and Codex's SQLite stores are not.
- **The Collector uploads each file as gzipped chunks**, one per request to the Hub's transcript endpoint, authenticated with the System's token. A chunk of a JSONL file holds only complete lines; a file that is written once uploads whole after it stops changing. A file that shrinks, or is replaced at the same path, starts a new generation from offset 0, so nothing already stored is overwritten.
- **The Hub acknowledges a chunk in the same transaction that stores it.** It accepts a chunk only at the offset it already holds for that file, stores it in PostgreSQL, and answers with the new total. A chunk at any other offset is answered with what the Hub holds, and the Collector resumes from there; a chunk it already holds is accepted again without effect. An upload counts toward the System's Last seen.
- **The Collector spools what the Hub has not acknowledged.** It copies new content into a spool in its state directory as it reads it and removes each chunk once acknowledged, so a Harness deleting a file loses nothing. The spool has no size limit; `service status` shows its size and the age of its oldest content, and the Collector warns when it holds more than a day of content.
- **The Hub keeps transcripts as written until they are deleted on purpose.** Files are keyed by System, source name, path within the source, and generation. Chunks are stored compressed, as uploaded. `heimdall-hub transcripts delete` removes the transcripts of a System, of a source, or older than a date. Repeated history across files, and every Harness's format, are left as written for later analysis.

## Considered options

- Compressed files on the Hub's disk with an index in PostgreSQL. Rejected: it adds a second store to back up and a gap between storing and acknowledging that the code must close. At several gigabytes a year, PostgreSQL holds the archive comfortably.
- Capture on unless turned off. Rejected: a newly paired System would archive every prompt and tool output before anyone chose it.
- Main Session transcripts only. Rejected: it loses subagent spend and any large tool output once the Harness prunes it.
- A capped spool that drops the oldest content. Rejected: an outage longer than the cap would silently lose part of the archive.

## Consequences

The Hub's database, and the backups of it, grow by several gigabytes a year for each busy System.
A forgotten System captures nothing; the Hub can show which Systems capture which sources.
During a long Hub outage, a busy System's spool grows by tens of megabytes a day.
The capture configuration differs between Systems, as [ADR-0009](0009-collectors-pair-with-the-hub.md)'s clarification anticipates.
A Harness that changes where or how it writes transcripts needs a Collector release before its new files are captured.
