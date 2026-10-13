---
type: adr
title: ADR-0015 - The dashboard is its own app, reading the Hub's database
description: "M6's dashboard is a separate TypeScript app built with TanStack Start, Tailwind, and shadcn/ui, with shadcn charts on Recharts, that reads the Hub's PostgreSQL database directly as the Hub's role. The Hub ingests what Collectors send and derives from it; the dashboard app serves every read, its pages and the read API alike. It runs as its own Service on the Hub's System and ships in releases beside the binaries."
status: accepted
created: 2026-10-13
modified: 2026-10-13
---

# The dashboard is its own app, reading the Hub's database

## Context

The Hub renders one plain page as HTML strings (`packages/hub/src/page.ts`). M6 replaces it with the full dashboard chosen from static mocks: every System as a lane on a shared time axis with its CPU, agent Sessions, and Conditions, and a System detail page that stacks Vitals, Harness processes, and Sessions on one axis and inspects a single sample. That design needs synchronized charts, hover and selection across them, and range changes, which string-rendered HTML handles poorly.

The Hub's HTTP API mixes two directions. Collectors write to it: Reports, transcript uploads, and pairing. Provisioners read from it: `GET /api/v1/records`. Reads written in the Hub and again in a dashboard would give one question two implementations.

Heimdall runs on a single-person tailnet, and [ADR-0009](0009-collectors-pair-with-the-hub.md) treats database access as trusted.

## Decision

- **The dashboard is its own app** in `packages/dashboard`: TypeScript, TanStack Start, Tailwind, and shadcn/ui, with shadcn's chart components on Recharts. It is not compiled into the Hub binary.
- **It reads the Hub's database directly.** TanStack Start server functions query PostgreSQL as the Hub's role, reading whatever tables and views a screen needs. Session facts come from the `insight` views, so a Session's cost or token count has the one definition [ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md) gives it. The dashboard does not write.
- **The Hub ingests and derives.** It keeps the Collector-facing endpoints (Reports, transcript uploads, and pairing redemption) and its health check, derives Conditions, rollups, and Session insight, owns the schema and its migrations, and keeps its admin commands on its own System.
- **The dashboard app serves every read.** Its pages and the read API, `GET /api/v1/records` and any later read endpoint, are TanStack Start routes in the same app, sharing their queries. The records read moved there whole; the Hub no longer serves it.
- **It runs as its own Service on the Hub's System** and ships in each release beside the Collector and Hub binaries.
- **Its type is Barlow Semi Condensed**, from Fontsource, served by the app itself.
- **The Hub's page stays** until the dashboard shows everything it shows.

## Considered Options

- **Server-rendered HTML with inline SVG in the Hub.** One binary and no frontend toolchain, but the shared-axis charts and the sample inspector would be hand-built.
- **A Hub JSON read API for the dashboard.** It keeps the database private to the Hub, but every screen would need an endpoint in a second app.
- **A read-only role reading views only.** It stops the dashboard from writing and keeps it off the Hub's tables, but needs a role, grants, and a view for every table the dashboard reads.
- **Moving ingestion into the app as well.** Report ingestion derives Conditions in the same transaction, and transcript uploads acknowledge chunks against stored offsets; both run beside the Hub's timers and migrations, so moving them would rewrite the Hub without a gain.

## Consequences

- The dashboard depends on the Hub's tables as they are. A Hub migration that changes a table the dashboard reads changes the dashboard in the same pull request.
- The dashboard holds the Hub's database credentials, with the same trust as the Hub.
- A provisioner that reads records reads them from the app's address.
- A release has a third deliverable beside the binaries [ADR-0006](0006-releases-ship-both-binaries-installed-by-script.md) describes, and a provisioner installs and runs it beside the Hub.

## Changelog

- 2026-10-13: Amended before any code relied on it. The Hub's HTTP API no longer stays whole: the Hub keeps ingestion, and the dashboard app serves every read, the records read included.
- 2026-10-13: The records read moved to the app in one change, with no period in which the Hub also served it, so its query has one implementation (HMD-86). A provisioner switches to the app's address when it upgrades the Hub.
