---
description: "The fleet observability spec: the roles in a Heimdall fleet, the principles that divide their work, what a provisioner records with a Collector and what Heimdall checks, how a provisioner reads the records back, and how agent Session transcripts reach the Hub."
---

# Fleet observability spec

A fleet is a person's own set of Systems. Heimdall observes a fleet and the agent work done on it, whatever provisions its Systems. This spec states what each role does and what a provisioner follows to plug in. [ADR-0011](decisions/0011-collectors-hold-what-provisioners-record.md) and [ADR-0012](decisions/0012-hub-archives-agent-session-transcripts.md) record why. Terms are defined in the [glossary](glossary.md).

Roles and Principles describe Heimdall as designed. Sections marked _planned_ describe contracts not built yet, whose exact fields are fixed when the milestone that builds them lands ([roadmap](roadmap.md)).

## Roles

| Role | Runs | Does |
| --- | --- | --- |
| System | everywhere | One machine in the fleet, named by a DNS label. |
| Collector | on each System, as one account | Samples Vitals, observes agent Sessions, holds what provisioners record, checks it, and sends Reports and transcripts to the Hub. |
| Hub | on one System | Stores Reports and transcripts in PostgreSQL, derives Conditions, mirrors each System's records, and serves the dashboard. |
| Provisioner | wherever its operator runs it | Installs things on Systems and records them with each System's Collector. Fleet is one provisioner; [Running Heimdall with Fleet](fleet.md) shows how it does this. |

A System joins by pairing its Collector with the Hub once, as the [README](../README.md#pairing-a-new-system) describes.

## Principles

1. **The Collector holds what is on its System.** A provisioner tells it what it installed; the Hub mirrors that and manages nothing.
2. **Heimdall compares recorded with observed, on one System.** A recorded Service that stopped, a recorded job that missed its schedule, and a recorded file that changed are Heimdall's to report.
3. **The provisioner compares declared with recorded.** Heimdall stores no provisioner's declarations. Gaps such as declared but not installed are found by the provisioner's own check, which reads the records the Hub mirrors.
4. **Heimdall reports and never manages.** Nothing the Hub sends changes a Collector's records or what it observes.
5. **Every record is optional.** A System nobody records anything on still shows its Vitals and its agent Sessions.
6. **The Hub keeps agent Session transcripts** as the durable record of agent work, after each Harness deletes its own copy.

## Recording what a provisioner installed

A provisioner records something it installed by piping one JSON object to `heimdall-collector record <kind>`, and removes it with `heimdall-collector forget <kind> <name>`. It runs both as the account the Collector runs as, so the records land in that Collector's state, even when the install itself ran as another account such as root. The kinds are `application`, `service`, `job`, and `files`.

`record` reads at most 1 MiB from standard input and refuses a terminal. It exits 1, stores nothing, and names the field and the problem when the input is empty, is not JSON, fails the rules below, or carries a field the kind does not list; it never repeats the input. A mistake therefore fails the provisioner's command at once, and a field is never dropped without notice. On success it prints `Recorded <kind> <name>.` and exits 0. Recording a kind and name again replaces the record. `forget` removes the record and exits 0 with `No <kind> <name> is recorded.` when there is none, so an uninstall script can run it whether or not the install was recorded. Forgetting a job also removes its runs.

Records live in `records.sqlite` in the Collector's state directory, which `record` creates, readable by its owner alone, if it is missing. Pairing is not required. Wiping the directory loses the records, and the provisioner records them again. A new kind or supervisor is added only when a provisioner needs it.

### Fields

A name is 1 to 128 characters: letters, digits, `.`, `_`, and `-`, starting with a letter or digit. A text field is 1 to 256 characters of well-formed Unicode with no control characters. Every kind may carry `provenance`, which is optional: `by`, text of at most 64 characters, and optionally `revision`, text of at most 128. Heimdall shows it and never compares it.

| Kind | Fields |
| --- | --- |
| `application` | `name`, `version` (text of at most 128 characters), optional `source` (text), optional `provenance`. |
| `service` | `name`, `supervisor`, optional `health`, optional `port`, optional `provenance`. The supervisor decides what names the Service to it: `unit` for `systemd` and `systemd-user`, `label` for `launchd`, `container` for `docker`, and no target for `none`. `health` is `http://127.0.0.1:<port>` or `http://[::1]:<port>`, optionally followed by a path of printable ASCII other than space, with a port from 1 to 65535; `localhost` and every other host are refused. `port` is an integer from 1 to 65535. |
| `job` | `name`, `scheduler`, `schedule`, optional `provenance`. The scheduler decides what names the job to it: `label` for `launchd`, `unit` for `systemd-timer`. `schedule` lists 1 to 100 calendar entries in the System's local time, with the meaning of launchd's `StartCalendarInterval`: each entry has at least one of `minute` (0 to 59), `hour` (0 to 23), `day` (1 to 31), `weekday` (0 to 7, where 0 and 7 are both Sunday), and `month` (1 to 12), all integers, and a field left out matches every value. Two identical entries, with weekday 0 and 7 counted as equal, are refused. Recording a job again keeps its runs. |
| `files` | `name`, `files` (1 to 10,000 entries of `path` and `sha256`), optional `provenance`. A `path` is absolute and normalized, at most 4096 bytes, and has no control characters: it has no empty, `.`, or `..` segment and no trailing slash, and `/` alone is not a file. Paths within a record are unique. A `sha256` is 64 lowercase hexadecimal characters. |

A job reports each run with `heimdall-collector record run <job>`, which reads one JSON object from standard input like the other kinds. The job must have a `job` record, and the command exits 1 for a run of one that has none. A run has `started` and `finished`, UTC times in ISO 8601 with whole seconds such as `2026-10-01T03:00:05Z`, where `finished` is not earlier than `started`; `exitStatus`, an integer from 0 to 255, where 0 is success; and optionally `output`, with `file`, the output file's name without any directory, and `sizeBytes`, a non-negative integer. Runs are keyed by job and `started`, so recording the same start again replaces the run. Recording a run prunes that job's runs that started more than 90 days earlier, except the job's latest successful run. A run that is itself that old, and not the latest success, is not kept: the command exits 0 and prints `Run of <job> started <started> is older than 90 days and was not kept.` instead of `Recorded run of <job> started <started>.` A job's runner should ignore a failure to record, so a broken Collector never fails the job.

### Examples

```json
{"name": "webapp", "version": "1.4.2", "source": "https://example.com/webapp-1.4.2.tar.gz", "provenance": {"by": "my-provisioner", "revision": "3f9c2ab"}}
```

```json
{"name": "webapp", "supervisor": "systemd", "unit": "webapp.service", "health": "http://127.0.0.1:8080/healthz", "port": 8080}
```

```json
{"name": "nightly-backup", "scheduler": "systemd-timer", "unit": "nightly-backup.timer", "schedule": [{"hour": 3, "minute": 30}]}
```

```json
{"name": "webapp-config", "files": [{"path": "/etc/webapp/webapp.conf", "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}]}
```

```json
{"started": "2026-10-01T03:30:00Z", "finished": "2026-10-01T03:42:17Z", "exitStatus": 0, "output": {"file": "backup-2026-10-01.tar.gz", "sizeBytes": 73400320}}
```

The last example is the input to `heimdall-collector record run nightly-backup`.

### What Heimdall checks and reports _(planned, M4)_

The Collector reports its records to the Hub, as [Reading the records back](#reading-the-records-back) describes, and checks those it can observe. The checks arrive in later M4 work.

| Kind | Heimdall checks and reports |
| --- | --- |
| `application` | Reported as recorded; the version is not observed. |
| `service` | Supervisor state, and health from the URL, which the Collector requests only on loopback. A stopped or unhealthy Service raises Service down. |
| `job` | Each run the job reports. A failed run raises job failing; a scheduled time plus a grace period that passed while the System was awake, with no successful run since, raises job overdue. |
| `files` | Each file's current hash. A file that no longer matches raises Drift. |

A new field reaches the dashboard only when every layer knows it, so the Hub is upgraded first, then the Collectors, and only then does a provisioner send the field.

## Reading the records back

The Collector sends its whole record set in a Report's `records` section when it starts, when a `record` or `forget` changes the set, and an hour after the Hub last accepted the set. The section carries each record as the provisioner recorded it and the kind and name of each record the Collector could not read from its own state. A job's runs are not part of the set. The Hub replaces the System's mirror with each set, so a forgotten record leaves the mirror, and it ignores a set sent earlier than the one it holds. A Report without the section leaves the mirror unchanged.

The Hub drops a field it does not know from a mirrored record. It counts a record of a kind or shape it does not know as unreadable, since the record still exists on the System. A set whose JSON is larger than 8 MiB is sent as its size alone, and the Hub then holds no records for that System until a smaller set arrives. The shapes are in `packages/schema/src/records-section.ts`.

`GET /api/v1/records` returns every System's records, with the same trust as the dashboard. The answer lists each System the dashboard shows, sorted by name, in one of three forms:

```json
{"systems": [
  {"system": "web-1", "sentAt": "2026-10-10T08:00:00.000Z", "receivedAt": "2026-10-10T08:00:01.250Z",
   "records": [{"kind": "service", "name": "webapp", "record": {"name": "webapp", "supervisor": "systemd", "unit": "webapp.service"}}],
   "unreadable": [{"kind": "job", "name": "nightly-backup"}]},
  {"system": "build-1", "sentAt": "2026-10-10T08:00:00.000Z", "receivedAt": "2026-10-10T08:00:00.900Z",
   "overBudget": {"bytes": 9437184}},
  {"system": "laptop-1", "records": null}
]}
```

`records` is `null` until a Report carries the System's set, which a Collector older than this section never sends. Such a System's records are unknown, not empty. Records are sorted by kind, then name, and times are UTC in ISO 8601.

## Agent Session transcripts

A System captures transcripts only from the sources its Collector configuration lists ([ADR-0013](decisions/0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)). Capture is off until a source is listed:

```toml
[[sessions.sources]]
harness = "claude-code"            # its standard directory

[[sessions.sources]]
harness = "claude-code"
dir = "~/.claude-work"             # a second profile
name = "claude-work"
```

Each source names a Harness, and optionally a directory and a name, which default to the Harness's standard location and its name. A directory is absolute or starts with `~/`. Two sources may not share a name or a directory, even through a symbolic link, and the Collector refuses to start with such a configuration or with a Harness it does not know. A source whose directory does not exist is skipped, so one configuration can list every source a fleet uses. The Collector reads each directory as its own account and reports each source as capturing, absent, or unreadable. Adding a source uploads the history already in it.

| Harness | Standard directory | Session tree |
| --- | --- | --- |
| `claude-code` | `~/.claude` | `projects/` |
| `codex` | `~/.codex` | `sessions/` |

The Collector uploads every file of a source's session tree to the Hub as it grows, separately from Reports, as gzipped chunks the Hub acknowledges by offset. It keeps content the Hub has not acknowledged in a spool, so a Harness pruning its files loses nothing. It reads the trees every 60 seconds, reads only regular files, follows no symbolic link inside a tree, and skips a file whose name is not UTF-8, which has no path the Hub accepts. A JSONL file's chunks end on line boundaries; a last line without a newline, and a whole file that is not JSONL, upload once the file is unchanged across two scans. The Hub stores transcripts as written and keeps them until they are deleted on purpose.

### Upload protocol

A Collector uploads with its System's token as a bearer token, like a Report. The limits and request shapes are in `packages/schema/src/transcripts.ts`.

1. **Open a generation** for each file the Collector has not uploaded before, and whenever a file it has uploaded shrinks, is replaced, or stops matching what it uploaded: `POST /api/v1/transcripts/generations` with `{"source": "claude-code", "path": "projects/my-project/0b1c.jsonl"}`. The path is relative to the source's directory, as the directory lists it, with `/` between segments, and is valid UTF-8 of at most 4096 bytes; a file whose name cannot be written so has no path the Hub accepts. The Hub answers `201` with `{"generation": 42, "held": 0}`.
2. **Send each chunk** of the file in order: `POST /api/v1/transcripts/generations/42/chunks` with the gzipped chunk as the body, as one gzip member or several concatenated, and its offset, counted in bytes of the file before compression, in the `Heimdall-Offset` header. A chunk carries at most 1 MiB of the file and its body at most 2 MiB. The Hub stores the chunk as uploaded and answers `{"held": <bytes of the file it holds>}` in the same transaction.

| Answer | Meaning | The Collector |
| --- | --- | --- |
| `200 {"held": n}` | The chunk is stored, or the Hub held it already. | Removes what the Hub holds from its spool. |
| `409 {"held": n}` | The offset is not where the Hub's content ends. | Resumes from `n` when its spool continues there. Otherwise, as when the Hub holds more than the file has, the file starts over in a new generation. |
| `410` to an open | Every generation at the path was deleted on purpose. | Stops uploading the path and drops its spooled content. |
| `410` to a chunk | The generation was deleted on purpose. A newer generation at the same path may survive. | Drops the generation's spooled content. If the file still grows into it, opens a new generation at the path, and stops the path when that open is refused. |
| `404` | The System opened no such generation. | Opens a new generation when the spool still holds the file from its first byte; otherwise drops the spooled content, and the file starts over in a new generation at the next scan. |
| `401`, `403` | No token, or a token no System holds. | Keeps its spool and retries. |
| `413`, `422` | The chunk body is over the cap, is not gzip, or unpacks past the chunk limit, or the request is malformed, such as an open with an invalid path or a body over 32 KiB. | Keeps that file's spool and retries after backing off, while other files still upload; it is a Collector bug. |

Every upload counts toward the System's Last seen, and no refusal raises a Condition. Every Report carries a `transcripts` section: each source's name, Harness, and status, and the spool's size and the time of its oldest content. A Collector that captures nothing sends no sources and, once what a removed source left is uploaded, an empty spool. The Hub keeps each System's section from the latest Report it was sent in; a Report from a Collector older than this section leaves it unchanged.

`heimdall-hub transcripts delete` deletes whole generations that match every filter given: `--system`, `--source`, and `--before <date>`, which compares a generation's last upload with the start of that day in UTC. At least one filter is required, and `--dry-run` reports what would be deleted. Once every generation at a path is deleted, the Hub refuses new generations there.

The Collector observes each Session's processes from the process table, recording only executable names and working directories, never command-line arguments or environment variables.

## Trust

Collectors send Reports with their System's token, but the dashboard and `GET /api/v1/records` have no authentication; they rely on a tailnet only its operator can reach. Its database holds every transcript, including anything an agent read. Authentication, and handling of secrets in transcripts, come before Heimdall is used anywhere else.
