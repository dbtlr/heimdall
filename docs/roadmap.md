---
description: "Heimdall milestones from walking skeleton through the Session archive, fleet state from provisioner records, Session insight, and the dashboard, with the settled scope of v1."
---

# Roadmap

Heimdall gives one view of a personal fleet and the agent work done on it: whether each System is up, its Vitals, the Services and jobs its provisioner recorded and whether they are healthy, and what each agent Session did and cost. See the [glossary](glossary.md) for terms, [decisions](decisions/README.md) for the settled design, and the [spec](spec.md) for what a provisioner follows.

## Shape of v1

- A Collector on every System pushes Reports to the Hub, which stores them in its own PostgreSQL database and serves a web dashboard inside the tailnet that works on a phone.
- Any provisioner records what it installed with `heimdall-collector record`. Heimdall compares those records with what the Collector observes and stores no provisioner's declarations ([ADR-0011](decisions/0011-collectors-hold-what-provisioners-record.md)).
- The Hub archives agent Session transcripts, content included, as the durable record of agent work ([ADR-0012](decisions/0012-hub-archives-agent-session-transcripts.md)).
- Vitals are CPU, memory, disk, load, and uptime, sampled every 15 seconds. Raw samples are kept for 14 days and 5-minute min/avg/max rollups for a year.
- A System that sleeps contributes only while awake: the dashboard shows its last-seen time and a gap. While awake but offline, the Collector keeps a bounded queue (about 24 hours) and flushes it on reconnect.
- v1 is dashboard-only. Conditions are visible in the UI; nothing is delivered.

## Out of v1

- Alerting and its delivery channel. A later milestone delivers Conditions the Hub already derives.
- A watcher outside the System that hosts the Hub. The Hub cannot report an outage of its own System.
- Comparing a provisioner's declarations with its records. That is the provisioner's own check, such as `fleet doctor`, reading the records the Hub mirrors.
- A dashboard that adds or changes a System's records ([ADR-0011](decisions/0011-collectors-hold-what-provisioners-record.md)).
- Harness hooks; transcripts already hold what hooks would report.
- General-purpose metrics, logs, or traces. Heimdall is not Prometheus.

## M1: Walking skeleton

One Collector reports Vitals to a running Hub, end to end.

- Bun monorepo with `packages/schema`, `packages/collector`, and `packages/hub` ([ADR-0003](decisions/0003-typescript-on-bun-for-collector-and-hub.md)).
- Report schema v1: System identity, Collector version, Vitals samples, and the Collector's own footprint.
- The Collector samples Vitals on macOS and Linux, queues locally, and Pushes batches to the ingest endpoint with a per-System token.
- The Hub authenticates the token, writes Reports to PostgreSQL through versioned migrations, and serves a plain page listing Systems with last-seen time and current Vitals.
- A rejected Report still counts as seeing its System and raises the first Condition, Reports rejected; each System's Timeline records Conditions raised and cleared ([ADR-0005](decisions/0005-rejected-reports-count-as-seen-conditions-keep-a-timeline.md)).
- Proven on a macOS System reporting to a Hub on another System: every Vital sampled, and no sample lost across a Hub outage.

Size: medium. De-risks the wire schema, cross-platform sampling, and the offline queue before anything depends on them.

## M2: Fleet rollout

Every System runs a Collector, and the Hub runs as a Fleet-managed Service.

- Tagged releases publish the Collector and Hub binaries for every platform, with install scripts Fleet runs to install and update them ([ADR-0006](decisions/0006-releases-ship-both-binaries-installed-by-script.md), [Releasing](releasing.md)).
- Both binaries install and supervise their own Service through `service` commands: a systemd user unit on Linux and a launchd user agent on macOS. Each reads its settings from `~/.config/heimdall/`, which Fleet renders ([ADR-0007](decisions/0007-binaries-own-their-service-config-file-holds-settings.md)).
- The Hub ships as a Fleet Application with a native Service on its System (Fleet ADR-0021): its own systemd user unit, Tailscale ingress, and a health check against `/api/health`.
- PostgreSQL database and login role `heimdall` declared in Fleet's registry, plus a Backup Job.
- The Collector ships as a Fleet Application on all four Systems, running as a launchd user agent on macOS and a systemd service on Linux.
- Each System pairs with the Hub once: the Hub issues a short-lived Pairing code, the Collector redeems it for its System name and token, and the Hub keeps only token hashes in its database ([ADR-0009](decisions/0009-collectors-pair-with-the-hub.md)).
- Retention: raw Vitals pruned after 14 days, 5-minute rollups kept for a year. Rollups update as samples arrive, and the Hub prunes on a timer ([ADR-0008](decisions/0008-vitals-roll-up-as-they-arrive-serve-prunes.md)).
- Proven with v0.2.0: the Hub runs as its Fleet native Service with a Backup Job, and Collectors on two Linux Systems and one macOS System pair with it, run under their own Services, and report. The fourth System, a desktop Mac, joins later.

Size: medium. Depends on the Fleet asks for packaging, the database, and a Darwin native supervisor and an unprivileged account on the System that lacks one.

## M3: Session archive

Every agent Session's transcript reaches the Hub before its Harness deletes it ([ADR-0012](decisions/0012-hub-archives-agent-session-transcripts.md)).

- The Collector finds each supported Harness's transcript files and uploads them as they grow, separately from Reports, resending from what the Hub already holds and keeping content the Hub has not acknowledged.
- The Hub stores transcripts as written, without parsing them, so later analysis can reprocess the archive.
- A System captures only the transcript sources its Collector configuration lists; capture is off by default ([ADR-0013](decisions/0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)).

Size: medium. It comes first because transcripts lost to pruning cannot be recovered. Sharp edges: files that grow while being read, and the size of the Hub's database and backups.

## M4: Fleet state

The dashboard answers "is everything each System's provisioner recorded still healthy?" ([ADR-0011](decisions/0011-collectors-hold-what-provisioners-record.md)).

- `heimdall-collector record` and `forget` hold a provisioner's Applications, Services, jobs, and files in the Collector's state; jobs report their runs with `record run`.
- The Collector checks what it can observe: each Service's supervisor state and loopback health, each job's runs, and each recorded file's hash. It reports its whole record set in Reports whenever it changes.
- The Hub mirrors each System's records, returns them on request for a provisioner's own check, and derives Conditions: Service down, job failing or overdue, Drift, stale System, and low disk. Each joins the Timeline M1 started.
- Fleet records what it installs and builds its own declared-against-recorded check (Fleet-side work in the Fleet repository).

Size: medium to large. The record contract lands in the [spec](spec.md) before provisioners build against it.

## M5: Session insight

Agent work becomes visible: what each Session did, used, and cost, and which Session caused a spike.

- The Hub derives each Session's model, tokens, tools, skills, context used, and approximate cost from its stored transcript, per Harness.
- The Collector detects Harness processes and records Sessions with Harness, working directory, start and end, and aggregate CPU and memory across the process tree, on the same time axis as Vitals.
- The Collector reports each Harness's installed version without running Harness binaries.
- The archive can be queried across months, by a person or an agent.

Size: large. Sharp edges: each Harness's transcript format, a price table for cost, and process-tree aggregation that differs between macOS and Linux.

## M6: Dashboard

The full UI, designed before it is built.

- Static mock variants first. One is chosen before any component is written.
- Fleet overview: every System with last seen, headline Vitals, and open Conditions.
- System detail: Vitals charts with min/max ranges and Session overlays, recorded Services and jobs with their health and runs, Applications, Drift, and the Timeline.
- Session views: what each Session did and cost.
- Readable on a phone.

Size: large. M1's plain page carries the project until here. Mocks can start once M4 and M5 fix the data shape.

## Later

- Hardening before anyone else runs Heimdall: authentication for the dashboard and its reads, and handling of secrets that appear in transcripts.
- Alerting: deliver Conditions through a chosen channel, with silencing.
- An external watcher for the System that hosts the Hub.
