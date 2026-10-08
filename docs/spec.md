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

## Agent Session transcripts _(planned, M3)_

The Collector finds the transcript files of each supported Harness and uploads them to the Hub as they grow, separately from Reports. An upload the Hub refuses or does not receive is sent again from what the Hub already holds, and the Collector keeps a copy of content the Hub has not acknowledged. The Hub stores transcripts as written and keeps them until they are deleted on purpose. Capture can be turned off per System in the Collector's configuration.

The Collector observes each Session's processes from the process table, recording only executable names and working directories, never command-line arguments or environment variables.

## Trust

Collectors send Reports with their System's token, but the dashboard and reads of the records have no authentication; they rely on a tailnet only its operator can reach. Its database holds every transcript, including anything an agent read. Authentication, and handling of secrets in transcripts, come before Heimdall is used anywhere else.
