---
type: adr
title: ADR-0002 - The Collector observes processes, never content
description: "Agent Sessions are observed from the process table. Heimdall stores program names and working directories, never transcripts or command-line arguments."
status: superseded
superseded_by: ADR-0012
created: 2026-10-05
modified: 2026-10-08
---

# The Collector observes processes, never content

## Context

Heimdall correlates CPU and memory spikes with agent Sessions.
A spike is usually caused by a process a Session started, such as a test run, build, or install, rather than the Harness process itself.
Session identity can come from the process table, from Harness hooks, or from transcript files.
Command-line arguments can carry tokens and prompts.

## Decision

The Collector identifies Sessions by scanning the process table for Harness processes.
For each Session it records the Harness, the working directory, start and end times, and CPU and memory aggregated across the Session's process tree.
Heimdall stores executable names and working directories only. It never stores command-line arguments, environment variables, or transcript content.

## Considered options

- Harness hooks reporting Session IDs. Deferred, not rejected: they add a per-Harness integration and not every Harness has hooks. They may later enrich process-observed Sessions with an ID that links to a transcript.
- Reading transcript files. Rejected: the observability store would hold conversation content.

## Consequences

Session correlation works identically for every Harness with no integration.
A Session has no stable link to its transcript until a hook-based enrichment exists.
Any later feature that wants argument or content data needs a new decision that supersedes this one.

## Changelog

- 2026-10-08: Superseded by [ADR-0012](0012-hub-archives-agent-session-transcripts.md). The Hub archives Session transcripts, content included. Process observation still records no command-line arguments or environment variables.
