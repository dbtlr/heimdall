---
description: Index of Heimdall's architecture decision records, with the status semantics that govern how each decision binds current work.
---

# Decisions

Architecture decision records (ADRs). Each decision's frontmatter `status` says how it binds the work in front of you:

- **accepted**: load-bearing. Change course only through a new ADR that supersedes it.
- **proposed**: a candidate, not yet a constraint. Discuss work that would violate one before proceeding.
- **superseded**: follow the decision named in `superseded_by` instead; this one remains for history.
- **deprecated**: no longer applies.

## Index

- [ADR-0001 — Fleet declares, the Collector observes, the Hub remembers](0001-fleet-declares-collector-observes-hub-remembers.md)
- [ADR-0002 — The Collector observes processes, never content](0002-collector-observes-processes-never-content.md)
- [ADR-0003 — TypeScript on Bun for the Collector and the Hub](0003-typescript-on-bun-for-collector-and-hub.md)
- [ADR-0004 — The Report grows additively, and samples are keyed by System and time](0004-report-grows-additively-samples-keyed-by-system-and-time.md)
- [ADR-0005 — A rejected Report still counts as seeing its System, and Conditions keep a Timeline](0005-rejected-reports-count-as-seen-conditions-keep-a-timeline.md)
- [ADR-0006 — Releases ship both binaries per platform, installed by one script each](0006-releases-ship-both-binaries-installed-by-script.md)
