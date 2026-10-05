---
type: adr
title: ADR-0003 - TypeScript on Bun for the Collector and the Hub
description: "Collector, Hub, and the shared Report schema are TypeScript packages in one Bun monorepo; the Collector ships as a compiled single binary."
status: accepted
created: 2026-10-05
modified: 2026-10-05
---

# TypeScript on Bun for the Collector and the Hub

## Context

The Collector runs on macOS and Linux and is installed as a Fleet Application, so it must be a self-contained binary with no toolchain on the System.
The Collector and the Hub share the Report wire schema.
Mimir, another Fleet Application, is a Bun monorepo shipping compiled binaries.

## Decision

Heimdall is one Bun monorepo with `packages/schema`, `packages/collector`, and `packages/hub`.
The Collector ships as a `bun build --compile` single binary per platform.
Both sides import the Report schema from `packages/schema`.
The Collector reports its own CPU and memory as Vitals from its first release, so its footprint stays visible.

## Considered options

- A Go Collector with a TypeScript Hub. Rejected for now: roughly 10 MB resident instead of 30 to 50 MB, at the cost of two languages and a schema maintained twice. Revisit if the Collector's own Vitals show its footprint matters.

## Consequences

One language and one schema definition cover the whole system.
The Collector binary is around 60 MB on disk, comparable to the Mimir CLI.
