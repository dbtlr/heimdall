---
description: "Heimdall's domain vocabulary: fleet, System, provisioner, record, Application, Service, job, Drift, Collector, Hub, Report, Vitals, Harness, Session, subagent, transcript, source, generation, request, cost, Harness process, Condition, Last seen, Timeline, Pairing, and Pairing code."
---

# Glossary

Heimdall observes a fleet and the agent work done on it, whatever provisions its Systems. The terms below are Heimdall's own.

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
Software a provisioner installed on a System and recorded with its version. The Collector reports it as recorded and does not observe the version.
_Avoid_: package, app

**Service**:
A long-running program a provisioner recorded, with its supervisor, its unit, label, or container, and optionally a loopback health URL. The Collector checks its supervisor state and health; a stopped or unhealthy Service raises the Service down Condition.
_Avoid_: daemon, process

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
The service that receives Reports and transcripts, stores them in PostgreSQL, derives Conditions, mirrors each System's records, and serves the web dashboard.
_Avoid_: server, backend

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

**cost**:
What a Session's or a request's tokens would cost at the model's API list prices on the day they were used: an approximation, not what a subscription plan billed. A model with no known price is unpriced, never free.
_Avoid_: bill, charge, price (the per-token rate cost is computed from)

**Harness process**:
A running Harness as the Collector observes it from the process table, with its working directory, start and end, and the CPU and memory it and its descendants use. One can run several Sessions in turn, and the Hub links it to a Session only when the match is unambiguous.
_Avoid_: Session (the conversation, not the process), agent process

**Condition**:
A problem state the Hub derives for a System from what it receives, such as Reports rejected, a Service down, a job failing or overdue, Drift, a stale System, or low disk. The dashboard shows open Conditions and the Timeline records each one raised and cleared; a later alerting phase delivers them.
_Avoid_: alert (delivery, not the state), finding, incident

**Last seen**:
The most recent time the Hub heard from a System under that System's token, whether it stored the Report, rejected it, or took a transcript upload. A sleeping System shows its last-seen time and a gap.
_Avoid_: heartbeat (the mechanism, not the fact), uptime (a Vital)

**Timeline**:
A System's history of Conditions being raised and cleared, newest Condition first. It shows where a System failed and when it recovered, while the dashboard shows where it stands now.
_Avoid_: event feed, event log (a Report is never an event)

**Pairing**:
How a Collector gets its identity: once per System, an operator has the Hub issue a Pairing code bound to the System's name and redeems it on that System, and the Collector keeps the System name and token the Hub returns. Pairing again rotates the token; unpairing revokes it, hides the System from the dashboard's normal view and the records read, and keeps its history, which the dashboard's unpaired view still shows; `?unpaired=include` adds its last records to the records read.
_Avoid_: enrollment, registration, provisioning (a provisioner's install, not Heimdall's identity)

**Pairing code**:
A short, single-use code the Hub issues for one System's Pairing, valid for minutes. It carries no identity until the Hub redeems it.
_Avoid_: token (the lasting credential a Collector sends with each Report), key, password
