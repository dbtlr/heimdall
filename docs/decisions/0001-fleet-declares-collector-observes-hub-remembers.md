---
type: adr
title: ADR-0001 - Fleet declares, the Collector observes, the Hub remembers
description: "Fleet's compiled per-System Inventory is the only contract between Fleet and Heimdall. Collectors push Reports to the Hub; the Hub never reads Fleet source."
status: accepted
created: 2026-10-05
modified: 2026-10-05
---

# Fleet declares, the Collector observes, the Hub remembers

## Context

Heimdall shows the state of every Fleet System: Vitals, the Services, Backup Jobs, and Applications Fleet manages, and whether each matches what Fleet declared.
Only Fleet's source knows the declared state.
Fleet already Pushes `manifest.json` to each System, recording the commit, `installedAt`, and a hash per Managed path, which is enough to compute Drift and the last Push.
Services, Backup Jobs, and Application releases are installed outside Push and appear in no shipped file.
Asgard, which hosts the Hub, is not a Center and carries no Fleet toolchain.

## Decision

Fleet compiles a per-System **Inventory** Artifact and Pushes it next to `manifest.json`.
The Inventory is a versioned JSON document listing the System's declared Services with their supervisors, Backup Jobs with schedules and retention, Applications with their selected releases, and Harnesses.

The Collector on each System reads the Inventory and `manifest.json`, observes the actual state of each entry, and sends Reports carrying both declared and observed state to the Hub.
Collectors push Reports over HTTPS inside the tailnet to the Hub's ingest endpoint. They never connect to PostgreSQL.
The Hub stores Reports and derives Conditions. It never reads Fleet source or contacts Centers.

## Considered options

- The Hub reads the Fleet repository directly. Rejected: Asgard would need a checkout and the Fleet toolchain, contrary to Fleet's rule that anything needing a toolchain runs on a Center.
- The Collector infers managed state from running processes. Rejected: it cannot tell managed from foreign processes, and cannot detect a declared Service that is missing.
- Collectors write directly to PostgreSQL. Rejected: every System would hold database credentials, and every schema change would couple to every Collector release.

## Consequences

The Inventory schema is a cross-project contract. Fleet owns producing it; Heimdall owns consuming it. Breaking changes bump its version, and the Collector reports an unknown version as a Condition instead of guessing.
Heimdall can show only what Fleet declares; an undeclared process is never a managed process.
The Hub's database is one more tenant under Fleet's ADR-0014, and an Asgard outage takes the Hub down with it.
