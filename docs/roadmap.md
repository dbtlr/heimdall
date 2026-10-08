---
description: "Heimdall milestones from walking skeleton to Fleet state, Session correlation, and the dashboard, with the settled scope of v1."
---

# Roadmap

Heimdall gives one view of where every Fleet System stands: whether it is up, its Vitals, the Services and Backup Jobs Fleet manages on it, and whether it matches what Fleet declared. See the [glossary](glossary.md) for terms and [decisions](decisions/README.md) for the settled design.

## Shape of v1

- A Collector on every System Pushes Reports to the Hub ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)).
- The Hub stores Reports in its own PostgreSQL database on the System that hosts it and serves a web dashboard inside the tailnet that works on a phone.
- Desired state comes only from the Inventory Fleet publishes to the Hub and each System's `manifest.json` ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)).
- Vitals are CPU, memory, disk, load, and uptime, sampled every 15 seconds. Raw samples are kept for 14 days and 5-minute min/avg/max rollups for a year.
- Sessions are observed from the process table, never from content ([ADR-0002](decisions/0002-collector-observes-processes-never-content.md)).
- A System that sleeps contributes only while awake: the dashboard shows its last-seen time and a gap. While awake but offline, the Collector keeps a bounded queue (about 24 hours) and flushes it on reconnect.
- v1 is dashboard-only. Conditions are visible in the UI; nothing is delivered.

## Out of v1

- Alerting and its delivery channel. A later milestone delivers Conditions the Hub already derives.
- A watcher outside the System that hosts the Hub. The Hub cannot report an outage of its own System.
- Session IDs linked to transcripts through Harness hooks.
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

## M3: Fleet state

The dashboard answers "does each System match what Fleet declared?" ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)).

- `packages/schema` publishes the Inventory schema, and `heimdall-hub inventory publish` and `inventory current` store and report the Inventory Fleet publishes.
- Fleet publishes the Inventory on every command that changes a System, writes an install record for each thing it installs, and writes a run record for each Backup Job run (Fleet-side work; see the asks document in the Fleet repository).
- The Collector reads `manifest.json`, the install records, and the run records, and reports: last Push or Apply and its commit, Drift per Managed path, each installed Service's supervisor state and health, each Backup Job's last run and exit status, each Application's installed release, and each Harness version.
- The Hub compares the Inventory, the install records, and the Collector's checks, and derives Conditions: declared but not installed, installed differently than declared (including a release behind its channel), installed but not declared, Service down, Backup Job overdue or failing, Drift, stale System, and low disk. Each joins the Timeline M1 started.

Size: large. The Inventory schema and the install record format are the contracts; land them before building the Collector side.

## M4: Session correlation

Spikes can be traced to the agent Session that caused them.

- The Collector detects Harness processes and records Sessions with Harness, working directory, start and end, and aggregate CPU and memory across the process tree.
- The Hub stores Sessions and exposes them on the same time axis as Vitals.

Size: medium. Sharp edge: process-tree aggregation differs between macOS and Linux, and short-lived children fall between 15-second samples.

## M5: Dashboard

The full UI, designed before it is built.

- Static mock variants first. One is chosen before any component is written.
- Fleet overview: every System with last seen, headline Vitals, and open Conditions.
- System detail: Vitals charts with min/max ranges and Session overlays, managed Services and Backup Jobs with their schedules, Applications and releases, Drift, and the Timeline.
- Readable on a phone.

Size: large. M1's plain page carries the project until here. Mocks can start any time after M3 fixes the data shape.

## Later

- Alerting: deliver Conditions through a chosen channel, with silencing.
- An external watcher for the System that hosts the Hub.
- Harness hook enrichment that links Sessions to transcripts.
