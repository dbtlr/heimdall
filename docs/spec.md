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

## Recording what a provisioner installed _(planned, M4)_

A provisioner records something it installed by piping a JSON record to `heimdall-collector record <kind>`, and removes it with `heimdall-collector forget <kind> <name>`. It runs both as the account the Collector runs as, so the records land in that Collector's state, even when the install itself ran as another account such as root.

The Collector validates a record when it is recorded and refuses one that is invalid or carries a field it does not know, so a mistake fails the provisioner's command at once. A record may carry provenance, such as the provisioner's name and revision, which Heimdall shows and never compares. Records are keyed by kind and name, and a job's runs by job and start time. They live in the Collector's state directory, so wiping it loses them, and the provisioner records them again. A new kind or supervisor is added only when a provisioner needs it.

| Kind | A provisioner records | Heimdall checks and reports |
| --- | --- | --- |
| `application` | Name, installed version, optional source | Reported as recorded; the version is not observed. |
| `service` | Name; supervisor (`systemd`, `systemd-user`, `launchd`, `docker`, or `none`); its unit, label, or container; optional health URL and port | Supervisor state, and health from the URL, which must be on loopback; its exact form is fixed in M4. A stopped or unhealthy Service raises Service down. |
| `job` | Name; scheduler (`launchd` or `systemd-timer`); its label or unit; its schedule | Each run the job reports. A failed run raises job failing; a scheduled time plus a grace period that passed while the System was awake, with no successful run since, raises job overdue. |
| `files` | Paths and their hashes, after the provisioner writes them | Each file's current hash. A file that no longer matches raises Drift. |

A job reports each run with `heimdall-collector record run <job>`: when it started and finished, its exit status, and optionally the output file it wrote and its size. A job's runner should ignore a failure to record, so a broken Collector never fails the job.

A new field reaches the dashboard only when every layer knows it, so the Hub is upgraded first, then the Collectors, and only then does a provisioner send the field.

## Reading the records back _(planned, M4)_

Whenever a Collector's records change, it sends the whole set in a Report, and the Hub replaces that System's mirror with it. The Hub returns every System's records on request, with the same trust as the dashboard, so a provisioner can compare them with what it declares. Whether the read is a Hub command or a read-only endpoint is decided when it is built.

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

Each source names a Harness, and optionally a directory and a name, which default to the Harness's standard location and its name. A directory is absolute or starts with `~`. Two sources may not share a name or a directory, and the Collector refuses to start with such a configuration or with a Harness it does not know. A source whose directory does not exist is skipped, so one configuration can list every source a fleet uses. The Collector reads each directory as its own account and reports each source as capturing, absent, or unreadable. Adding a source uploads the history already in it.

| Harness | Standard directory | Session tree |
| --- | --- | --- |
| `claude-code` | `~/.claude` | `projects/` |
| `codex` | `~/.codex` | `sessions/` |

The Collector uploads every file of a source's session tree to the Hub as it grows, separately from Reports, as gzipped chunks the Hub acknowledges by offset. It keeps content the Hub has not acknowledged in a spool, so a Harness pruning its files loses nothing. It reads the trees every 60 seconds, follows no symbolic link, and skips a file whose name is not UTF-8, which has no path the Hub accepts. A JSONL file's chunks end on line boundaries; a last line without a newline, and a whole file that is not JSONL, upload once the file is unchanged across two scans. The Hub stores transcripts as written and keeps them until they are deleted on purpose.

### Upload protocol

A Collector uploads with its System's token as a bearer token, like a Report. The limits and request shapes are in `packages/schema/src/transcripts.ts`.

1. **Open a generation** for each file the Collector has not uploaded before, and whenever a file it has uploaded shrinks, is replaced, or stops matching what it uploaded: `POST /api/v1/transcripts/generations` with `{"source": "claude-code", "path": "projects/my-project/0b1c.jsonl"}`. The path is relative to the source's directory, as the directory lists it, with `/` between segments, and is valid UTF-8 of at most 4096 bytes; a file whose name cannot be written so has no path the Hub accepts. The Hub answers `201` with `{"generation": 42, "held": 0}`.
2. **Send each chunk** of the file in order: `POST /api/v1/transcripts/generations/42/chunks` with the gzipped chunk as the body and its offset, counted in bytes of the file before compression, in the `Heimdall-Offset` header. A chunk carries at most 1 MiB of the file and its body at most 2 MiB. The Hub stores the chunk as uploaded and answers `{"held": <bytes of the file it holds>}` in the same transaction.

| Answer | Meaning | The Collector |
| --- | --- | --- |
| `200 {"held": n}` | The chunk is stored, or the Hub held it already. | Removes what the Hub holds from its spool. |
| `409 {"held": n}` | The offset is not where the Hub's content ends. | Resumes from `n`, or opens a new generation when its file is shorter than `n`. |
| `410` to an open | Every generation at the path was deleted on purpose. | Stops uploading the path and drops its spooled content. |
| `410` to a chunk | The generation was deleted on purpose. A newer generation at the same path may survive. | Drops the generation's spooled content. |
| `404` | The System opened no such generation. | Opens a new generation. |
| `401`, `403` | No token, or a token no System holds. | Keeps its spool and retries. |
| `413`, `422` | The chunk body is over the cap, is not gzip, or unpacks past the chunk limit, or the request is malformed, such as an open with an invalid path or a body over 32 KiB. | Keeps its spool and retries; it is a Collector bug. |

Every upload counts toward the System's Last seen, and no refusal raises a Condition. Every Report carries a `transcripts` section: each source's name, Harness, and status, and the spool's size and the time of its oldest content. A Collector that captures nothing sends no sources and an empty spool. The Hub keeps each System's section from the latest Report it was sent in; a Report from a Collector older than this section leaves it unchanged.

`heimdall-hub transcripts delete` deletes whole generations that match every filter given: `--system`, `--source`, and `--before <date>`, which compares a generation's last upload with the start of that day in UTC. At least one filter is required, and `--dry-run` reports what would be deleted. Once every generation at a path is deleted, the Hub refuses new generations there.

The Collector observes each Session's processes from the process table, recording only executable names and working directories, never command-line arguments or environment variables.

## Trust

Collectors send Reports with their System's token, but the dashboard and reads of the records have no authentication; they rely on a tailnet only its operator can reach. Its database holds every transcript, including anything an agent read. Authentication, and handling of secrets in transcripts, come before Heimdall is used anywhere else.
