---
type: adr
title: ADR-0011 - Collectors hold what provisioners record, and Heimdall stores no declarations
description: "Any provisioner tells a System's Collector what it installed through the Collector's command line, and the Collector keeps those records in its own state, checks each against the System, and reports both to the Hub. Heimdall compares recorded state with observed state on one System; comparing declarations with records belongs to the provisioner, which can read the Hub's inventory. Supersedes ADR-0010."
status: accepted
created: 2026-10-08
modified: 2026-10-08
---

# Collectors hold what provisioners record, and Heimdall stores no declarations

## Context

[ADR-0010](0010-fleet-publishes-inventory-collectors-read-install-records.md) had Fleet publish its whole-fleet Inventory to the Hub and leave install and run records on each System for the Collector to read.
Specifying those contracts showed that they tie Heimdall to one provisioner's model:

- The Inventory schema encodes Fleet's release channels, supervisors, Backup Job settings, database registry, and commit ordering.
- Every Fleet behavior becomes a Heimdall rule. Fleet installs a `systemd` Service as root, so the record format had to say which account owns a record. Services that Fleet's own commands handle fit no supervisor the format named.
- The comparison the design centered on, declared against installed, needs the declarations, their history, and the provisioner's toolchain. All three live with the provisioner, not with Heimdall.

Heimdall's repository is public, and the problems it observes are not specific to Fleet. A person who provisions their own set of Systems with any tool has the same questions: is each System up, is what was installed still running, and are scheduled jobs running on time.

## Decision

- **A provisioner is any tool or person that installs things on a System.** Fleet is one provisioner. Heimdall names none and depends on none.
- **The Collector holds what provisioners record.** A provisioner records something it installed by piping JSON to `heimdall-collector record <kind>`, and removes it with `heimdall-collector forget <kind> <name>`. The Collector validates each record when it is recorded, so a bad record fails the provisioner's command at once, and refuses a field it does not know, since the provisioner sees the refusal and a dropped field would read as never recorded. It keeps its records in its state directory, keyed by kind and name, and a job's runs by job and start time. A provisioner runs `record` as the account the Collector runs as, so the records land in that Collector's state. The first kinds, whose exact fields are fixed when they are built and documented in Heimdall's spec, are:
  - `application`: name, installed version, and optional source.
  - `service`: name, its supervisor (`systemd`, `systemd-user`, `launchd`, `docker`, or `none`), its unit, label, or container, and an optional loopback health URL and port.
  - `job`: name, its scheduler (`launchd` or `systemd-timer`), its label or unit, and its schedule. A job reports each run with `heimdall-collector record run <job>`: start, finish, exit status, and an optional output file and its size.
  - `files`: paths and their hashes, recorded after a provisioner writes them.

  A record may carry provenance, such as the provisioner's name and revision, which Heimdall shows and never compares.
- **The Collector reads no provisioner's files.** Fleet's `manifest.json` included: a provisioner that wants Drift reported records the files it writes.
- **Every record is optional.** A System that no provisioner records anything on still reports Vitals and Sessions. Each kind adds its checks only when something of that kind is recorded.
- **Heimdall compares recorded state with observed state on one System.** The Collector checks each record against the System and reports the records with the checks: a Service's supervisor state and health, whose URL it requests only on loopback; each job's runs; and each recorded file's hash. The Hub derives Conditions from those gaps, such as Service down, job failing, and Drift. A job is overdue when one of its scheduled times plus a grace period passed while its System was awake with no successful run since.
- **Comparing declarations with records is the provisioner's job.** Heimdall stores no provisioner's declarations. The Hub mirrors every System's records and returns all of them on request, so a provisioner can check what it declares against what each System holds, as a `fleet doctor` would. Returning records is a read, with the same trust as the dashboard; whether it is served through the Hub's command line or a read-only endpoint is part of building it. Heimdall retires the term Inventory, which named Fleet's declared snapshot.
- **Heimdall reports and never manages.** Nothing the Hub sends changes a Collector's records or what it observes. A way for the dashboard to add or change a record would reverse this and needs its own decision.
- **Collectors push to the Hub and never connect to its database,** as before. Records and checks travel in Reports, whose growth ADR-0004 governs.
- **The record contract starts minimal and grows additively.** A new optional field keeps a kind's meaning; a new kind or supervisor is added only when a provisioner needs it.

## Considered options

- Fleet publishes its declared Inventory to the Hub, and Collectors read install records Fleet writes as files ([ADR-0010](0010-fleet-publishes-inventory-collectors-read-install-records.md)). Rejected for the reasons in Context. Files were chosen there only because the writer was another project, which could not be asked to learn Heimdall's storage. Once the Collector writes its own state, it validates at the writer, owns the format, and holds records the account it runs as can always read.
- The Hub compares declarations that a provisioner supplies with each request and stores none. Rejected: Heimdall would still model the provisioner's declarations, and a dashboard showing the differences would have to keep them between requests.
- Provisioners deliver declarations to each Collector, which relays them to the Hub. Rejected: a provisioner reaches a System only when it acts on it, so a System it has not touched since a declaration changed, or one that was asleep, would hold stale declarations, the same flaw that retired [ADR-0001](0001-fleet-declares-collector-observes-hub-remembers.md).
- The Hub sends each Collector a list of what to check. Rejected, as in ADR-0010: a compromised Hub could direct every Collector at arbitrary local ports.

## Consequences

Install gaps, such as declared but not installed, installed differently than declared, and installed but not declared, are found by the provisioner's own check, not by Heimdall, and appear only when that check runs.
The dashboard shows what each System holds and whether it is healthy, not whether it matches a provisioner's declarations.
Provisioners depend on the Collector binary to record installs, and a job's runner depends on it to report runs. A runner should ignore a failure to record, so a broken Collector never fails a job.
A new record field reaches the dashboard only when every layer knows it. The Hub drops Report fields it does not know (ADR-0004) and a Collector refuses record fields it does not know, so the Hub is upgraded first, then the Collectors, and only then does a provisioner send the field.
A provisioner that acts as another account, such as root installing a system Service, must run `record` as the Collector's account; a record written to another account's state reaches no Collector.
The Hub knows a System from its pairing, not from any declaration, so a stale System is one that paired and stopped reporting.
Records live in the Collector's state directory with its identity and queue, so wiping that directory also loses them, and provisioners record them again.
The Fleet Inventory schema and the `heimdall-hub inventory` publish ADR-0010 introduced are removed.
