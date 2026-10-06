---
description: "Heimdall milestones from walking skeleton to Fleet state, Session correlation, and the dashboard, with the settled scope of v1."
---

# Roadmap

Heimdall gives one view of where every Fleet System stands: whether it is up, its Vitals, the Services and Backup Jobs Fleet manages on it, and whether it matches what Fleet declared. See the [glossary](glossary.md) for terms and [decisions](decisions/README.md) for the settled design.

## Shape of v1

- A Collector on every System Pushes Reports to the Hub ([ADR-0001](decisions/0001-fleet-declares-collector-observes-hub-remembers.md)).
- The Hub stores Reports in its own PostgreSQL database on the System that hosts it and serves a web dashboard inside the tailnet that works on a phone.
- Desired state comes only from Fleet's per-System Inventory Artifact and `manifest.json`.
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
- Per-System ingest tokens rendered from 1Password through the Application's config template.
- Retention: raw Vitals pruned after 14 days, 5-minute rollups kept for a year. Rollups update as samples arrive, and the Hub prunes on a timer ([ADR-0008](decisions/0008-vitals-roll-up-as-they-arrive-serve-prunes.md)).

Size: medium. Depends on the Fleet asks for packaging, the database, and a Darwin native supervisor and an unprivileged account on the System that lacks one.

## M3: Fleet state

The dashboard answers "does each System match what Fleet declared?"

- Fleet compiles and Pushes the Inventory Artifact (Fleet-side work; see the asks document in the Fleet repository).
- The Collector reads the Inventory and `manifest.json` and reports: last Push or Apply and its commit, Drift per Managed path, each declared Service's supervisor state and health, each Backup Job's last run, exit status, and next due time, each Application's installed release against the selected release, and each Harness version.
- The Hub derives Conditions: Service down, Backup Job overdue or failing, Drift, release mismatch, stale System, low disk, unknown Inventory version. Each joins the Timeline M1 started.

Size: large. The Inventory contract is the main risk; land and version it before building the Collector side.

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
