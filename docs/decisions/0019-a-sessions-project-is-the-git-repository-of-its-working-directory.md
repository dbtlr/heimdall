---
type: adr
title: ADR-0019 - A Session's project is the git repository of its working directory
description: "A Session's project is the git repository its working directory belongs to. The Collector resolves that repository for the Harness processes it observes, by reading only git's pointer files, and the Hub matches a Session's working directory to those processes. Sessions in every linked worktree of one repository share a project."
status: accepted
created: 2026-10-18
modified: 2026-10-18
---

# A Session's project is the git repository of its working directory

## Context

The dashboard groups Sessions by project. It derived one from the last folder of a Session's working directory.
That fails for a linked worktree: a Session in `.../worktrees/heimdall/t3-d175d0ae` is filed under `t3-d175d0ae`, though it belongs with every other Session of the repository `heimdall`.

The repository is a fact about the System's filesystem.
The Hub cannot see that filesystem, and the transcript records only a path.
[ADR-0012](0012-hub-archives-agent-session-transcripts.md) has the Collector upload transcripts as written, and [ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md) has the Hub derive every fact from them with a parser per Harness.
The Collector already reports each Harness root process's working directory, and the Hub links processes to Sessions by matching paths (ADR-0012 sets what it may read).

## Decision

**A Session's project is the git repository its working directory belongs to**, named by the folder of the repository's main worktree.
A working directory outside any repository names itself.

**The Collector resolves the repository for each Harness process it observes** and reports it as the process's `repository`: the absolute path of the repository's main worktree, or null.
It walks up from the process's working directory to the first `.git` entry and reads only git's pointer files:

- A `.git` directory makes its parent the repository.
- A `.git` file holds a `gitdir:` pointer. When that directory has a `commondir` file, as a linked worktree's does, the repository is the parent of the common directory it names, or for a bare repository the common directory itself without a trailing `.git`. A directory without one, a submodule's, is its own repository.
- With no `.git` entry, or a pointer that cannot be read, the repository is null.

It never runs git and never reads anything else in a repository.
It looks once for each directory a process is seen in.
The field is optional in the Report, so an older Collector omits it ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)).

**The Hub matches a Session to those processes.**
It stores each process's `repository`, the Harness process views carry it, and `insight.sessions` gains a `repository` column: the repository of the most recent Harness process on the Session's System whose working directory equals the Session's last (else first) working directory and that reported a repository.
The column is a locator, which ADR-0014 allows the views to carry.
The dashboard names a Session's project by its `repository`, else its working directory, taking the last folder of either.

## Considered options

- **Path patterns in the Hub's configuration.** Rejected: each worktree layout would need its own pattern, kept up to date by hand, and a layout nobody listed would fall back to the wrong name without warning.
- **The Collector parses the working directory out of transcripts and resolves it.** Rejected: it puts each Harness's transcript format in the Collector, which ADR-0012 and ADR-0014 keep in the Hub's parsers so that a format change needs only a Hub release.
- **Spawn `git rev-parse` for each directory.** Rejected: it needs git installed on every System, costs a process for each lookup, and can read repository configuration and content that the Collector has no reason to open.

## Consequences

A Session with no matching Harness process keeps the folder-name project.
That includes every Session from before this ships, Sessions from a Collector that predates it, and Sessions too short for the Collector to have seen their process.

Two different repositories whose main worktrees have the same folder name, on different Systems or the same one, share a project name.

The repository is as of the last time a process was seen in that directory.
A directory that becomes a repository later, or stops being one, changes a Session's project only through a process observed afterwards.

The Collector's allowed reads grow by the `.git` entry and `commondir` file on the way up from a working directory, none of which is repository content.
