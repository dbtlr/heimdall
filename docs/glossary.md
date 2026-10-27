---
description: "Heimdall's domain vocabulary: fleet, System, provisioner, record, Application, Service, installed version, upstream, available update, Service stop, job, Drift, Collector, Hub, dashboard, Report, Vitals, Harness, Harness install, Session, project, subagent, transcript, source, generation, request, Session insight, list-price cost, Harness process, Condition, level, delivery, silence, Last seen, Timeline, Pairing, and Pairing code."
---

# Glossary

Heimdall observes a fleet and the agent work done on it, whatever provisions its Systems. The terms below are Heimdall's own.
Condition levels and level-change history follow [ADR-0017](decisions/0017-the-hub-sets-condition-levels.md).
Delivery and silences follow [ADR-0020](decisions/0020-the-hub-delivers-alerts-through-ntfy.md).
Service stops follow [ADR-0021](decisions/0021-the-collector-logs-service-stops-and-the-hub-raises-a-note.md).
Installed versions, upstreams, and available updates follow [ADR-0022](decisions/0022-services-show-their-version-and-the-hub-checks-upstreams.md).

## Language

**fleet**:
A person's own set of Systems, which they provision and want to watch. Capitalized, Fleet names one provisioner, the one that installs and operates Heimdall today.
_Avoid_: cluster, estate, inventory

**System**:
One machine in a fleet, named by a DNS label, that runs a Collector.
_Avoid_: host, node, box

**provisioner**:
Any tool or person that installs things on a System and records them with that System's Collector. Heimdall stores no provisioner's declarations; comparing what a provisioner declares with what it recorded is the provisioner's own check.
_Avoid_: installer, manager, Fleet (one provisioner, not the role)

**record**:
What a provisioner tells a Collector it installed: an Application, a Service, a job, or a set of files. The Collector keeps its records in its own state, checks those it can observe, and reports them; the Hub mirrors each System's records. Every kind is optional.
_Avoid_: Inventory (retired; it named Fleet's declared snapshot), install record, manifest, declaration

**Application**:
Software a provisioner installed on a System and recorded with its version and, optionally, its upstream. The Collector reports it as recorded and does not observe the version.
_Avoid_: package, app

**Service**:
A long-running program a provisioner recorded, with its supervisor, its unit, label, or container, optionally a loopback health URL, and optionally the Application it runs. The Collector checks its supervisor state and health; a stopped or unhealthy Service raises the Service down Condition, and any Service stop raises the Service restarted note.
_Avoid_: daemon, process

**installed version**:
The version of the software a Service runs: its Docker image's tag, which the Collector observes, or otherwise the version of the Application the Service names. A Service with neither has an unknown installed version.
_Avoid_: current version, deployed version

**upstream**:
Where newer releases of a Service's software are published, named by kind: a GitHub repository, an npm package, a container image repository, or an APT or Homebrew package.
_Avoid_: source (a transcript source), origin, registry (one kind of upstream)

**available update**:
A release on a Service's upstream newer than its installed version on the same channel: a stable version counts only stable releases, and a prerelease also counts newer prereleases with its own label. It is shown with the Service and is never a Condition.
_Avoid_: outdated, pending update (an operating-system package update), Drift

**Service stop**:
A time a Service's supervisor shows it stopped, from when it stopped to when it ran again, with the result, exit status, and restart count the supervisor holds. A reboot is not a Service stop, and a failed health check is not one either.
_Avoid_: incident, outage, restart event

**job**:
A scheduled program a provisioner recorded, with its scheduler and schedule, such as a backup. It reports each run to the Collector, and the Hub judges whether it is failing, because its latest run failed, or overdue, because its System was awake for the job's grace period after a scheduled time with no successful run since.
_Avoid_: cron, task, Backup Job (a backup is a job whose runs report an output file)

**Drift**:
A recorded file whose content no longer matches the hash its provisioner recorded, or that no longer exists. A file the Collector cannot read is not Drift.
_Avoid_: change, diff

**Collector**:
The process that runs on each System, observes it, holds its records, and sends Reports and transcripts to the Hub. It runs only while its System is awake.
_Avoid_: agent (reserved for the AI driving a Harness), exporter, daemon

**Hub**:
The service that receives Reports and transcripts, stores them in PostgreSQL, derives Conditions, mirrors each System's records, and derives Session insight from transcripts.
_Avoid_: server, backend

**dashboard**:
The web app that serves every read of the fleet: pages that show every System's Vitals, records, and Conditions, and its agent Sessions, and the read API. It runs on the Hub's System and reads the Hub's database, which it never writes; the Hub ingests.
_Avoid_: UI, frontend, console

**Report**:
One payload from a Collector to the Hub: a batch of Vitals samples, and the Collector's records and its checks of them. Its shape is the versioned wire schema. Transcripts travel separately.
_Avoid_: event, metric, ping

**Vitals**:
The small fixed set of host measurements: CPU, memory, disk, load, and uptime. Sampled as a time series so spikes are visible.
_Avoid_: metrics (too broad), telemetry

**Harness**:
An agent program, such as Claude Code or Codex, that runs Sessions and writes their transcripts.
_Avoid_: client, IDE, model

**Session**:
One main conversation in a Harness, started by a person or a program, together with its subagents; a Harness run that another Session's agent starts as a separate program, such as `codex exec`, is a Session of its own. What it did, used, and cost is derived from its transcripts.
_Avoid_: conversation (as a synonym), thread, run (a job's run)

**project**:
The git repository a Session's working directory belongs to, named by the repository's folder, so Sessions in every linked worktree of one repository share a project. A working directory outside any repository names itself, by its last folder. The Collector resolves the repository for the Harness processes it observes, and the Hub gives a Session the repository of the most recently started Harness process on its System that was seen in the same working directory and reported one, whether or not that process ran the Session ([ADR-0019](decisions/0019-a-sessions-project-is-the-git-repository-of-its-working-directory.md)).
_Avoid_: repo, workspace

**subagent**:
A child conversation that a Session's agent starts inside the same Harness, with its own transcript, model, and agent type. It can start subagents of its own, and its usage counts toward its Session.
_Avoid_: sidechain, child Session, worker

**transcript**:
The file a Harness writes for a Session, holding its prompts, responses, and tool calls. The Hub keeps it as the durable record of the Session after the Harness deletes its own copy.
_Avoid_: log (a binary's runtime lines), history

**source**:
A Harness directory that a System's Collector configuration lists for transcript capture, under a name unique on that System. A System captures transcripts only from its sources.
_Avoid_: profile, capture target

**generation**:
One continuous run of a transcript file's content, as the Hub holds it. When a file shrinks, is replaced, or no longer matches what was uploaded, its content continues in a new generation, so content from two different files is never joined.
_Avoid_: version, revision, upload

**request**:
One call from a Session or a subagent to its model, with the model and the tokens it used. It is the unit Heimdall counts and prices.
_Avoid_: turn (a prompt and everything the agent does in reply), message, API call

**Session insight**:
What the Hub derives from the transcripts it holds: each Session and subagent, each request, and each tool call, read through the `insight` views. It is a projection of the archive that the Hub rebuilds when a Harness's parser changes, so it never holds a fact the surviving transcripts do not.
_Avoid_: analytics, stats, metrics (too broad)

**list-price cost**:
What a request's tokens would cost at the model's API list prices on the day they were used: an approximation, not what a subscription plan billed. Each kind of token, such as input, output, and cache reads and writes, is priced separately, from a dated price table that configuration can override. A Session's list-price cost is the sum over its requests, subagents included. A request whose model has no price for its day is unpriced, never free, and a total that includes one has no list-price cost, only a count of its unpriced requests and a lower bound, the cost of the requests that are priced.
_Avoid_: cost (alone, where a subscription's spend could be meant), bill, charge, spend, price (the per-token rate list-price cost is computed from)

**Harness install**:
One copy of a Harness on a System, found by the Collector in a place such as a tool manager's install directory or an npm package, with its location kind and its version, or `unknown` when the version cannot be read. A System can have several. The Collector reads files to find it and never runs the Harness.
_Avoid_: Harness version (a System can hold several), installation

**Harness process**:
A running Harness root process as the Collector observes it from the process table: a process of a Harness whose parent is not a process of the same Harness. The Collector records its Harness, working directory, the repository that directory belongs to, start and end, and readings of the CPU time and memory of it and its descendants, and never command-line arguments or environment variables. The Hub keeps the process and stores its readings as samples on the Vitals time axis. A Codex subagent is a thread, not a process. One Harness process can run several Sessions in turn, and the Hub links it to a Session only when the match is unambiguous. An end the Collector did not see is marked as missed.
_Avoid_: Session (the conversation, not the process), agent process

**Condition**:
A state that needs notice or action, derived by the Hub for a System from what it receives and carrying a level. The same Condition stays open through level changes until it is cleared.
_Avoid_: alert (a level, not the Condition itself), finding, incident

**level**:
A Condition's urgency, set by the Hub: note means something to know about, warning means act this week, and alert means act now. A System's health is its worst open level; notes alone leave it healthy.
_Avoid_: severity, priority, score, notification (delivery, not a level)

**delivery**:
The Hub's messages about one Condition's time at alert: a push when it reaches alert, and a recovered message once it has stayed below alert for 10 minutes. Returns to alert in between are counted, not pushed. Notes and warnings are never delivered.
_Avoid_: notification, page, alert (a level, not the message)

**silence**:
A time-boxed hold on delivery for one System, set and ended with `heimdall-hub silence` and stored in the Hub's database. A silence never hides a Condition or changes a System's health. A Collector that stops reporting is quiet, not silenced.
_Avoid_: mute, snooze, acknowledgement

**Last seen**:
The most recent time the Hub heard from a System under that System's token, whether it stored the Report, rejected it, or took a transcript upload. A sleeping System shows its last-seen time and a gap.
_Avoid_: heartbeat (the mechanism, not the fact), uptime (a Vital)

**Timeline**:
A System's history of Conditions being raised, changing level, and being cleared, grouped by each raised Condition with the most recently raised first. A recurrence forms a separate group, while the dashboard shows where the System stands now.
_Avoid_: event feed, event log (a Report is never an event)

**Pairing**:
How a Collector gets its identity: once per System, an operator has the Hub issue a Pairing code bound to the System's name and redeems it on that System, and the Collector keeps the System name and token the Hub returns. Pairing again rotates the token; unpairing revokes it, hides the System from the dashboard's overview and the records read, and keeps its history, which the dashboard's unpaired lanes (`/?unpaired`, shown for any value but `false`) and its page still show; the records read needs exactly `?unpaired=include` to add its last records. Purging an unpaired System deletes that history, keeping its transcripts unless asked.
_Avoid_: enrollment, registration, provisioning (a provisioner's install, not Heimdall's identity)

**Pairing code**:
A short, single-use code the Hub issues for one System's Pairing, valid for minutes. It carries no identity until the Hub redeems it.
_Avoid_: token (the lasting credential a Collector sends with each Report), key, password
