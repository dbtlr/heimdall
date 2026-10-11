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

- [ADR-0001 — Fleet declares, the Collector observes, the Hub remembers](0001-fleet-declares-collector-observes-hub-remembers.md) (superseded by ADR-0010)
- [ADR-0002 — The Collector observes processes, never content](0002-collector-observes-processes-never-content.md) (superseded by ADR-0012)
- [ADR-0003 — TypeScript on Bun for the Collector and the Hub](0003-typescript-on-bun-for-collector-and-hub.md)
- [ADR-0004 — The Report grows additively, and samples are keyed by System and time](0004-report-grows-additively-samples-keyed-by-system-and-time.md)
- [ADR-0005 — A rejected Report still counts as seeing its System, and Conditions keep a Timeline](0005-rejected-reports-count-as-seen-conditions-keep-a-timeline.md)
- [ADR-0006 — Releases ship both binaries per platform, installed by one script each](0006-releases-ship-both-binaries-installed-by-script.md)
- [ADR-0007 — Each binary installs and supervises its own Service, and its config file is the one home for its settings](0007-binaries-own-their-service-config-file-holds-settings.md)
- [ADR-0008 — Vitals roll up into 5-minute buckets as they arrive, and serve prunes on a timer](0008-vitals-roll-up-as-they-arrive-serve-prunes.md)
- [ADR-0009 — Collectors pair with the Hub, and tokens live in the Hub's database](0009-collectors-pair-with-the-hub.md)
- [ADR-0010 — Fleet publishes the Inventory to the Hub, and Collectors read Fleet's install records](0010-fleet-publishes-inventory-collectors-read-install-records.md) (superseded by ADR-0011)
- [ADR-0011 — Collectors hold what provisioners record, and Heimdall stores no declarations](0011-collectors-hold-what-provisioners-record.md)
- [ADR-0012 — The Hub archives agent Session transcripts](0012-hub-archives-agent-session-transcripts.md)
- [ADR-0013 — Transcripts upload as acknowledged chunks into PostgreSQL, from sources each System opts into](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)
- [ADR-0014 — Session insight is a rebuildable projection, read through insight views](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)
