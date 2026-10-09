---
type: adr
title: ADR-0012 - The Hub archives agent Session transcripts
description: "Collectors upload each Harness's Session transcripts to the Hub, which keeps them as the durable record of agent Sessions, content included, so it can derive token spend, tools, skills, context, and cost and support analysis across months. Process observation still records no command-line arguments or environment variables. Supersedes ADR-0002."
status: accepted
created: 2026-10-08
modified: 2026-10-09
---

# The Hub archives agent Session transcripts

## Context

[ADR-0002](0002-collector-observes-processes-never-content.md) had the Collector observe Sessions only from the process table and rejected reading transcript files, so that the observability store would hold no conversation content.
Heimdall now observes the agent work on a fleet as much as the Systems it runs on. The questions it should answer need transcripts:

- What each Session spent in tokens, which model it used, which tools and skills it called, how much context it filled, and roughly what it cost.
- How agent work changes over months: what improved, what got worse, and which models suit which tasks, asked of the archive by a person or an agent.

Transcripts exist only on the System where the Session ran, and Harnesses delete old ones. No single place holds every Session, so history is lost as each Harness prunes.

## Decision

- **The Collector uploads each Harness's transcript files to the Hub as they grow.** The Hub stores them as written, without parsing on arrival, so later analysis can reprocess the whole archive when it improves. Uploads travel separately from the Reports that carry Vitals, and an upload the Hub refuses or does not receive is sent again from what the Hub already holds, never dropped. The Collector keeps a copy of transcript content the Hub has not yet acknowledged, so a Hub outage longer than a Harness's pruning loses nothing. The Hub saying how much of a file it holds is an acknowledgment, not an instruction about what to observe.
- **The Hub is the durable record of agent Sessions, content included.** Derived facts such as tokens, model, tools, skills, context, and cost come from the stored transcripts.
- **Capture can be turned off per System** in the Collector's configuration. Turning it off stops new uploads and leaves what the Hub already holds.
- **The Hub keeps transcripts until they are deleted on purpose.** Retention limits and a way to delete transcripts are part of the capture design.
- **Process observation is unchanged.** The Collector still identifies Sessions from the process table and records only executable names and working directories there, never command-line arguments or environment variables.

## Considered options

- Never read transcripts ([ADR-0002](0002-collector-observes-processes-never-content.md)). Rejected: it cannot answer what a Session spent or did, and the history it would need is deleted by the Harnesses.
- Read transcripts on the System and send only derived numbers and names. Rejected: the history still disappears when a Harness prunes, every new question needs a new Collector release, and nothing can be reprocessed.
- Harness hooks that report Session details. Still deferred: the transcript files already hold what hooks would report, hooks see only Sessions after they are installed, and not every Harness has hooks. Reading each Harness's transcript format is itself a per-Harness integration, which this decision accepts.

## Consequences

The Hub's database and its backups hold every prompt, every tool output, and anything an agent read, such as a file containing a secret, so their protection matters as much as the Systems'. [ADR-0009](0009-collectors-pair-with-the-hub.md) already treats read access to that database as trusted; that access now also exposes transcript content.
Transcripts are the largest data Heimdall stores. The Vitals retention of [ADR-0008](0008-vitals-roll-up-as-they-arrive-serve-prunes.md) does not apply to them, and the drop-on-422 rule of [ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md) does not apply to their uploads. Their compression, retention, and upload protocol are part of the capture design.
The Hub's dashboard has no authentication and relies on access to a single-person tailnet, so authentication and the handling of secrets in transcripts come before Heimdall is offered for use anywhere else.
Linking a transcript to its process-observed Session becomes possible, so a spike in Vitals could be traced to what the agent was doing; how is part of deriving Session insight.
The repository's rule that the Collector never stores transcript content is replaced by this decision.

## Changelog

- 2026-10-09: Clarification. [ADR-0013](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md) settles the capture design: a System captures only the sources its configuration lists, so capture is off until turned on, and it fixes the upload protocol, the spool, and storage in PostgreSQL. The decision is unchanged.
- 2026-10-09: Clarification. One refusal is not resent: an upload for a path deleted on purpose is refused as deleted, and the Collector stops uploading that path ([ADR-0013](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)). It acknowledges a deliberate delete and is not an instruction about what to observe. The decision is unchanged.
