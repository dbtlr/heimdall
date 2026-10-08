---
type: adr
title: ADR-0010 - Fleet publishes the Inventory to the Hub, and Collectors read Fleet's install records
description: "Fleet's git stays the only place desired state is written. Fleet publishes a whole-fleet Inventory snapshot to the Hub by running heimdall-hub inventory over SSH, against a schema Heimdall owns. Each Fleet install leaves a data-only install record on its System, and each Backup Job run leaves a run record. The Collector reads only those records and never takes instructions from the Hub; the Hub alone compares declared, installed, and running state. Supersedes ADR-0001."
status: accepted
created: 2026-10-08
modified: 2026-10-08
---

# Fleet publishes the Inventory to the Hub, and Collectors read Fleet's install records

## Context

[ADR-0001](0001-fleet-declares-collector-observes-hub-remembers.md) had Fleet compile a per-System Inventory Artifact, Push it next to `manifest.json`, and have the Collector read it to learn what to observe.
Grounding that plan against Fleet showed it fits Fleet poorly:

- Of what the Inventory lists, Fleet's Compile covers only Application config and packages. Services and Backup Jobs are installed by their own commands, so an Artifact refreshed only by Push would lag every install.
- Fleet pins no Application releases. An Application declares a channel, and Fleet resolves the tag at install time and records it nowhere.
- A System Fleet cannot reach stays unchanged until a later delivery, so a per-System file is stalest on the Systems most often offline.
- The Inventory would carry commands, such as an Application's version check, for the Collector to run.
- Fleet has no central state store; besides git it keeps only files it writes on each System, such as `manifest.json`. It already runs commands on the System that hosts the Hub over SSH as that System's package user.

## Decision

- **Fleet's git is the only place desired state is written.** Heimdall never edits a declaration. The Hub still never reads the Fleet repository or contacts a Center: the repository is private, and compiling it needs Fleet's toolchain, which runs only on a Center.
- **The Inventory is a whole-fleet snapshot that Fleet publishes to the Hub.** It lists the Systems with their OS and tags, and for each System its Applications with repository, channel, and the tag the channel resolves to at publish time, its Services with their supervisor, its Backup Jobs with schedule and retention, and its Harnesses, and it lists the databases Fleet manages. It is stamped with the Fleet commit it was compiled from. It carries no install commands, config templates, secrets, or observed state.
- **Fleet publishes through the Hub's command line over SSH.** `heimdall-hub inventory publish --expect-commit <sha>` reads the Inventory as JSON on standard input, validates it, and replaces the stored snapshot in one transaction. It refuses an invalid Inventory, a schema version the Hub does not know, and a stored commit other than the expected one; `--expect-commit none` expects that nothing is stored yet. `heimdall-hub inventory current` prints the stored commit, or `none`, and when it was published. SSH access to the Hub's System is the only credential, and no write endpoint exists on the network.
- **Fleet publishes on every action and never goes backwards.** Each Fleet command that changes a System publishes the whole snapshot from the commit it runs at, and an explicit publish command exists for publishing without acting. Fleet publishes only a commit on its main branch, from a clean tree, whatever the command, and only one that descends from the stored commit, which it checks with git before publishing when a commit is stored; otherwise the command acts and skips the publish with a warning. A revert is a new commit, so it moves forward. When the Hub refuses a publish, the Fleet command completes its action, prints the Hub's reason, and exits nonzero.
- **Heimdall owns the Inventory schema.** `packages/schema` publishes it as a versioned JSON Schema, and Fleet produces against it. A breaking change bumps the version, so the Hub is upgraded before Fleet publishes the new version.
- **Fleet leaves data-only records on each System.** Each Fleet command that installs or updates an Application, a Service (including those with their own commands), or a Backup Job writes an install record under Fleet's state directory, as `manifest.json` already records a Push: what it installed, the unit or label when Fleet names it, the loopback health URL when declared, the resolved release tag, the schedule, and the commit. Each Backup Job keeps a run record of its latest run and its latest successful run, with start, finish, exit status, and newest archive. Neither contains a command.
- **The Collector never takes instructions.** Its desired-state inputs are `manifest.json`, the install records, and the run records. It checks each install record against the System, such as its unit's supervisor state and its health URL, which it requests only on loopback, and reports the records alongside the checks. It finds Harnesses from the fixed list Heimdall keeps for Sessions. Nothing the Hub sends changes what the Collector observes or runs.
- **The Hub compares three layers.** The Inventory says what is declared, the install records say what Fleet installed, and the Collector's checks say what is running. The Hub derives a distinct Condition for each gap: declared but not installed, installed differently than declared, installed but not declared, and installed but not running, which for a Service is Service down. Install gaps are judged only for Applications, Services, and Backup Jobs, and only on a System whose Collector reports install records; a declared System that never reports is a stale System, and declared Harnesses and databases have no installed layer. Backup Jobs are overdue when a scheduled time plus a grace period passed while the System was awake with no successful run since. The Hub shows the Inventory's commit and when it was published; it does not order commits, because it has no git.
- **Collectors push Reports to the Hub's ingest endpoint inside the tailnet and never connect to PostgreSQL**, as before. The Hub's database remains a tenant of Fleet's PostgreSQL registry, so an outage of the System that hosts it takes the Hub down with it.

## Considered options

- The per-System Inventory Artifact of ADR-0001. Rejected for the reasons in Context: it lags installs, goes stale on sleeping Systems, and carries commands.
- Heimdall owns desired state and Fleet reads it. Rejected: Fleet installs the Hub, renders its config, creates its database, and backs it up, so rebuilding the Hub's System would need the Hub already running. Git also gives declarations review, history, and revert that a database would have to rebuild.
- The Hub sends each Collector a data-only list of what to check. Rejected: a compromised Hub could direct every Collector at arbitrary local ports, and install records give the same information over Fleet's trusted channel.
- The Collector watches every launchd job and crontab. Rejected: launchd's last exit status cannot show that a scheduled run never happened, and watching everything cannot tell Fleet's jobs from foreign ones.
- Fleet publishes through an HTTP endpoint with an operator token. Rejected: it adds a credential and a network write surface that SSH access already covers.
- CI publishes on every merge to the main branch. Deferred: it needs tailnet access and a Hub credential in CI. A declaration committed but not yet acted on reaches the Hub with the next Fleet command.

## Consequences

Fleet now contacts the Hub, which reverses a value Fleet's asks recorded. Fleet's side lands as asks in the Fleet repository: publish the Inventory, write install records, and write run records.
The Hub knows every declared System, including one whose Collector has never reported.
An Inventory error fails at the Fleet command that published it, not as a Condition seen later.
A release published between Fleet commands shows as installed differently than declared only after the next publish.
Removing a declaration leaves its install record on the System until Fleet removes the installed thing, and the Hub shows it as installed but not declared meanwhile.

## Changelog

- 2026-10-08: Addendum. The Hub refuses an Inventory with a field its schema does not name, where ADR-0004 drops unknown Report fields. The Inventory has one writer, which an operator runs and which reports a refusal at once, and a misspelled optional field that the Hub dropped would read as nothing declared. A breaking change remains a rename, a removal, or a change of meaning, as in ADR-0004, so a new optional field keeps the schema version; the Hub is upgraded before Fleet publishes it, as for a new version. The Inventory carries no publish time; the Hub records when it stored the Inventory, which is the time `inventory current` reports as published.
- 2026-10-08: Addendum. Fleet's state directory is `~/.fleet/`, which already holds `manifest.json`, so the records sit there: one install record per installed thing under `~/.fleet/installed/`, in a directory per kind because an Application and a Service can share a name, and one run record per Backup Job under `~/.fleet/backup-runs/`. A Collector drops record fields it does not know, as the Hub does for Reports (ADR-0004), where the Hub refuses unknown Inventory fields. Each System's Collector upgrades on its own schedule, so refusing would hide every record a newer Fleet writes until that Collector is upgraded. The JSON Schemas Fleet validates against still refuse unknown fields, so a misspelled field fails when Fleet writes it. A record of a schema version the Collector does not know is unreadable, and the Collector says so. A System whose Collector runs as an account other than the one Fleet acts as has no records that Collector can read, so it reports none and the Hub judges no install gaps there. The Services that Fleet's own commands handle get no install record, narrowing "including those with their own commands" above: they are not in the Inventory either, and their user units and launchd agents fit no supervisor the record names. They join both when Fleet declares them as Service Units.
