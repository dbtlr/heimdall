---
type: adr
title: ADR-0015 - The dashboard is its own app, reading the Hub's database
description: "M6's dashboard is a separate TypeScript app built with TanStack Start, Tailwind, and shadcn/ui, with shadcn charts on Recharts. Its server functions read the Hub's PostgreSQL database directly as the Hub's role, so the Hub's HTTP API stays a public interface. It runs as its own Service on the Hub's System and ships in releases beside the binaries."
status: accepted
created: 2026-10-13
modified: 2026-10-13
---

# The dashboard is its own app, reading the Hub's database

## Context

The Hub renders one plain page as HTML strings (`packages/hub/src/page.ts`). M6 replaces it with the full dashboard chosen from static mocks: every System as a lane on a shared time axis with its CPU, agent Sessions, and Conditions, and a System detail page that stacks Vitals, Harness processes, and Sessions on one axis and inspects a single sample. That design needs synchronized charts, hover and selection across them, and range changes, which string-rendered HTML handles poorly.

The Hub's HTTP API is what Collectors and provisioners use, such as `GET /api/v1/records`. Shaping it around one UI's screens would bind a public interface to the UI's needs.

Heimdall runs on a single-person tailnet, and [ADR-0009](0009-collectors-pair-with-the-hub.md) treats database access as trusted.

## Decision

- **The dashboard is its own app** in `packages/dashboard`: TypeScript, TanStack Start, Tailwind, and shadcn/ui, with shadcn's chart components on Recharts. It is not compiled into the Hub binary.
- **It reads the Hub's database directly.** TanStack Start server functions query PostgreSQL as the Hub's role, reading whatever tables and views a screen needs. Session facts come from the `insight` views, so a Session's cost or token count has the one definition [ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md) gives it. The dashboard does not write.
- **The Hub's HTTP API stays a public interface**, shaped for Collectors and provisioners, not for the dashboard.
- **It runs as its own Service on the Hub's System** and ships in each release beside the Collector and Hub binaries.
- **Its type is Barlow Semi Condensed**, from Fontsource, served by the app itself.
- **The Hub's page stays** until the dashboard shows everything it shows.

## Considered Options

- **Server-rendered HTML with inline SVG in the Hub.** One binary and no frontend toolchain, but the shared-axis charts and the sample inspector would be hand-built.
- **A Hub JSON read API for the dashboard.** It keeps the database private to the Hub, but every screen would need an endpoint, and those endpoints would become public interface.
- **A read-only role reading views only.** It stops the dashboard from writing and keeps it off the Hub's tables, but needs a role, grants, and a view for every table the dashboard reads.

## Consequences

- The dashboard depends on the Hub's tables as they are. A Hub migration that changes a table the dashboard reads changes the dashboard in the same pull request.
- The dashboard holds the Hub's database credentials, with the same trust as the Hub.
- A release has a third deliverable beside the binaries [ADR-0006](0006-releases-ship-both-binaries-installed-by-script.md) describes, and a provisioner installs and runs it beside the Hub.
