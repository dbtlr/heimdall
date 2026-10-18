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
That fails for a linked worktree: a Session in `.../worktrees/heimdall/fix-login` is filed under `fix-login`, though it belongs with every other Session of the repository `heimdall`.

The repository is a fact about the System's filesystem.
The Hub cannot see that filesystem, and the transcript records only a path.
[ADR-0012](0012-hub-archives-agent-session-transcripts.md) has the Collector upload transcripts as written, and [ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md) has the Hub derive every fact from them with a parser per Harness.
The Collector already reports each Harness root process's working directory, and the Hub links processes to Sessions by matching paths.
ADR-0012 limits what the Collector records from the process table to executable names and working directories; the repository comes from the filesystem, not the process table.

## Decision

**A Session's project is the git repository its working directory belongs to**, named by the repository's folder: the last folder of the path the Collector resolves below.
A working directory outside any repository names itself.

**The Collector resolves the repository for each Harness process it observes** and reports it as the process's `repository`, an absolute path, or null.
It walks up from the process's working directory to the first `.git` entry and reads only git's pointer files:

- A `.git` directory makes its parent the repository.
- A `.git` file holds a `gitdir:` pointer on its first line. When the git directory it names has a `commondir` file, as a linked worktree's does, the repository follows from the common directory that file names. A common directory whose name starts with a dot, such as `.git`, or the `.bare` of a bare repository kept inside its project folder, names its parent. One whose name ends in `.git`, such as a bare repository `heimdall.git`, names itself without that suffix. Any other names itself.
- A git directory without a `commondir` file, such as a submodule's or the `.bare` a project folder's own `.git` file points to, makes the working directory its own repository. So a project folder that holds a `.bare` repository and the worktrees added inside it all name the project folder.
- With no `.git` entry the repository is null. A `.git` entry that is there but unusable, such as one that is not a regular file or directory, a file with no `gitdir:` pointer, or a pointer to a missing directory, also makes it null, and the walk stops there instead of going further up.

It never runs git, opens only regular files, reads at most the first 4 KiB of each, and reads nothing else in a repository.
It looks a directory up when a process is first seen in it, and again only when the process's working directory changes.
The field is optional in the Report, so an older Collector omits it ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)).

**The Hub matches a Session to those processes.**
It stores each process's `repository` beside the working directory it was read for, the Harness process views carry it, and `insight.sessions` gains a `repository` column: the repository of the most recently started Harness process on the Session's System whose working directory equals the Session's last (else first) working directory and that reported a repository.
Any such process counts, whether or not it ran the Session.
The column is a fact the Collector observed about the System, not a locator into the archive.
ADR-0014 makes the archive the only source of truth for the projection, the rows parsed from transcripts; facts about processes are not projection rows, and `insight.request_links` already sets Collector-observed processes beside Sessions in a view the same way.
The dashboard names a Session's project by the last folder of its `repository`, else of its working directory, as it does too when the repository has no folder name, as `/` has none.

## Considered options

- **Path patterns in the Hub's configuration.** Rejected: each worktree layout would need its own pattern, kept up to date by hand, and a layout nobody listed would fall back to the wrong name without warning.
- **The Collector parses the working directory out of transcripts and resolves it.** Rejected: it puts each Harness's transcript format in the Collector, which ADR-0012 and ADR-0014 keep in the Hub's parsers so that a format change needs only a Hub release.
- **Spawn `git rev-parse` for each directory.** Rejected: it needs git installed on every System, costs a process for each lookup, and can read repository configuration and content that the Collector has no reason to open.

## Consequences

A Session with no matching Harness process keeps the folder-name project.
That includes every Session from before this ships, Sessions from a Collector that predates it, and Sessions too short for the Collector to have seen their process.

Two different repositories whose folders have the same name, on different Systems or the same one, share a project name.

Two layouts name the wrong path, because naming them right would take reading git's configuration, which the Collector does not:

- A linked worktree of a repository made with `--separate-git-dir` names the separate git directory, less any `.git` suffix, while the repository's main checkout names itself. Their Sessions share a project only when the two folders have the same name.
- A linked worktree of a submodule names the submodule's git directory inside the superproject's, such as `super/.git/modules/sub`. Its project is the submodule's name when that matches the submodule's folder.

The Collector never checks a directory again for a process it has looked up, so it misses a change made after that process started there.
A `git init` in a directory where a process is already running is not seen until a new process starts there or the process changes directory, and the process keeps reporting null until then.
A repository removed under a running process stays its repository.
The Hub takes the most recently started process in the directory that reported a repository and passes over those that reported null, so a directory that stops being a repository keeps its old project, for new Sessions too.
The column is computed when read, so once a process that started later reports a repository for a directory, every Session in that directory takes its project, earlier ones included.
A process is matched by the last directory it was seen in, since the Hub keeps one working directory for each process.

The Collector's allowed reads grow by the `.git` entry and `commondir` file on the way up from a working directory, at most 4 KiB of each, none of which is repository content.
