---
description: "Heimdall milestones from walking skeleton through the Session archive, fleet state from provisioner records, Session insight, the dashboard, and graded System health, with the settled scope of v1."
---

# Roadmap

Heimdall gives one view of a personal fleet and the agent work done on it: whether each System is up, its Vitals, the Services and jobs its provisioner recorded and whether they are healthy, and what each agent Session did and cost. See the [glossary](glossary.md) for terms, [decisions](decisions/README.md) for the settled design, and the [spec](spec.md) for what a provisioner follows.

## Shape of v1

- A Collector on every System pushes Reports to the Hub, which stores them in its own PostgreSQL database. A web dashboard, its own app reading that database, serves the fleet inside the tailnet and works on a phone.
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
- The Hub authenticates the token, writes Reports to PostgreSQL through versioned migrations. Its plain page, which listed Systems with last-seen time and current Vitals, carried the project until M6's dashboard showed everything it showed, and is gone.
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
- Proven with v0.3.0: Collectors on one Linux System and two macOS Systems capture Claude Code and Codex transcripts, history included, and the Hub's copy of every file on the Linux System matches it byte for byte. Through a three-minute Hub outage, each Collector kept what it spooled and every Vitals sample, and all of it reached the Hub within minutes of the restart. A System that lists no sources uploads nothing. The first upload of the existing history stored about 5 GB of transcripts as 1.1 GB in the database.

Size: medium. It comes first because transcripts lost to pruning cannot be recovered. Sharp edges: files that grow while being read, and the size of the Hub's database and backups.

## M4: Fleet state

The dashboard answers "is everything each System's provisioner recorded still healthy?" ([ADR-0011](decisions/0011-collectors-hold-what-provisioners-record.md)).

- `heimdall-collector record` and `forget` hold a provisioner's Applications, Services, jobs, and files in the Collector's state; jobs report their runs with `record run`.
- The Collector checks what it can observe: each Service's supervisor state and loopback health, each job's runs, and each recorded file's hash. It reports its whole record set in Reports whenever it changes.
- The Hub mirrors each System's records, returns them on request for a provisioner's own check, and derives Conditions: Service down, job failing or overdue, Drift, stale System, and low disk. Each joins the Timeline M1 started.
- Fleet records what it installs and builds its own declared-against-recorded check (Fleet-side work in the Fleet repository).
- Proven with v0.4.0, and v0.5.0 on one System: Fleet records Applications, Services, Backup Jobs, and the files it manages on three Systems, one Linux and two macOS. Recorded systemd, systemd-user, docker, launchd, and health URL checks report up, and a recorded Service that went missing raised Service down and cleared. Every Backup Job reports its runs, and a failing run raised job failing within a minute and a passing one cleared it. A hand-edited managed file among 138 recorded paths raised Drift. A laptop flipped in and out of stale System until its Collector said it sleeps, then stayed quiet. `fleet doctor` read the Hub's records and reported a record it does not declare. A System whose Collector runs under a separate account is left unrecorded by Fleet. The first Hub upgrade waited behind a stalled backup, which still held a lock, and migrated once the backup was stopped.

Size: medium to large. The record contract lands in the [spec](spec.md) before provisioners build against it.

## M5: Session insight

Agent work becomes visible: what each Session did, used, and cost, and which Session caused a spike.

- A versioned parser per Harness turns stored transcripts into a projection the Hub can always rebuild: each Session and subagent, each API request with its model, tokens, and context used, and each tool call, skill, and MCP tool. A parser version change rebuilds that Harness's rows from the archive ([ADR-0014](decisions/0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)).
- A Session is a main conversation, and its subagents count toward it. Totals are available with and without them.
- Cost is an approximation at API list prices, from a dated price table that ships with the Hub and that configuration can override. It is computed when read, and a model with no known price shows as unpriced.
- SQL views in an `insight` schema are the one read model. A read-only database role lets a person or an agent query months of history, and M6's reports read the same views. The views carry facts and locators, never transcript content; `heimdall-hub transcripts show` prints a Session's raw transcripts on the Hub's System.
- The Collector detects Harness processes and records each root process with its Harness, working directory, start and end, and CPU and memory summed over its process tree, on the same time axis as Vitals. The Hub links one to the Sessions it ran only when the match is unambiguous.
- The Collector reports each Harness's installed version without running Harness binaries.
- No new UI; M6 builds it on the views.
- Proven with v0.5.0: the three Systems that capture transcripts, one Linux and two macOS, show 729 Sessions and 183,090 requests in the insight views, no generation failed to parse, and every request is priced but 13 to third-party models, MiniMax and GLM, and one Codex request with no model. On the Linux System, 59 of 60 finished Codex Sessions match Codex's cumulative usage exactly; the other differs by the request that compacted it, which Codex's total leaves out. Of 129 finished Claude Code Sessions with usage, 38 match Claude Code's own tally exactly. The rest differ by side requests the transcript never records, by interrupted responses, or, in two Sessions, by an interrupted subagent response the transcript records and the tally misses, where the Hub matches the transcript. A 90-second load that an agent Session started held CPU between 99.2% and 99.7%, and `insight.vitals_sessions` traced it to that Session, whose process was the only candidate. The Hub's side of the proof is one read-only script over the insight views, run on the Hub's System.

Size: large. Sharp edges: duplicated usage in each Harness's transcript format, keeping parsers current as formats change, process-tree aggregation that differs between macOS and Linux, and linking processes to transcripts when Sessions overlap.

## M6: Dashboard

The full UI, designed before it is built, as its own app that reads the Hub's database ([ADR-0015](decisions/0015-dashboard-is-its-own-app-reading-the-hubs-database.md)).

- Static mock variants first. One is chosen before any component is written. The chosen direction puts every System on one time axis.
- Fleet overview: every System as a lane on a shared time axis, with its CPU, agent Sessions, Conditions where they were raised and cleared, last seen, and open Conditions.
- System detail: Vitals with min/max ranges, CPU per Harness process, and the System's Sessions stacked on one axis, with a panel that inspects one sample; recorded Services and jobs with their health and runs, Applications, Drift, and the Timeline.
- Session views: what each Session did and cost, mocked in a second round in the same direction.
- Readable on a phone.

Size: large. M1's plain page carried the project until the dashboard showed everything it showed, and the Hub no longer serves a page. Session facts come from M5's `insight` views.

## M7: System health

The dashboard answers "is any System unhealthy, and what needs me?" first, on a phone.

- Every Condition carries a level the Hub sets: a note to know about, a warning to act on this week, or an alert to act on now. A Condition keeps its identity as its level changes, and the Timeline records each change. A System's health is its worst open level, never a score, so notes never make a System look unhealthy.
- Every Condition names its culprit, such as the mount and how fast it fills, the process, or the package, and the dashboard shows that evidence with a next step.
- Low disk becomes graded disk: a note at 70% used, a warning at 80%, and an alert at 90%. Limits live in the Hub's configuration, with overrides per System; there is no muting.
- New Conditions: sustained CPU and memory (spikes stay in the charts), a hot process that holds a lot of CPU for a long time, named by its executable, and pending updates. The Collector checks pending apt, Homebrew, and macOS updates and whether a reboot is required, on an occasional schedule from local caches. Whether a provisioner's Application is behind its channel stays the provisioner's own check.
- The dashboard is rebuilt from a chosen mock: the Fleet page opens with a verdict and the Conditions that need you, ordered by level, then a compact card per System. A System page has a way back, a switcher between Systems, and tabs that each fit about one phone screen. An Agents view shows the fleet's list-price cost and Sessions across Systems. The shared-time-axis lanes move to a Compare view one tap from the Fleet page.
- Order: levels in the Hub first, with an ADR, since every health screen reads them. Dashboard navigation and the Agents view need no levels and run beside it. Load, hot-process, and update Conditions follow; the Collector running package managers gets its own ADR.

Size: large. Sharp edges: tuning limits so notes stay quiet, per-process CPU across sleeps, and running `brew` when the Collector's account does not own the Homebrew install.

## Later

- Hardening before anyone else runs Heimdall: authentication for the dashboard and its reads, and handling of secrets that appear in transcripts. Full-text search over transcript content waits for it.
- Alerting: deliver Conditions through a chosen channel, with silencing.
- An external watcher for the System that hosts the Hub.
