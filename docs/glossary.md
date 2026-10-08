---
description: "Heimdall's domain vocabulary: Collector, Hub, Inventory, Install record, Run record, Report, Vitals, Session, Condition, Last seen, Timeline, Pairing, and Pairing code, plus the Fleet terms it borrows."
---

# Glossary

Heimdall observes the Fleet. It borrows Fleet's vocabulary unchanged: **System**, **Center**, **Harness**, **Application**, **Service**, **Backup Job**, **Push**, **Apply**, **Managed path**, and **Drift** mean exactly what the Fleet glossary says. The terms below are Heimdall's own.

## Language

**Collector**:
The process that runs on each System, observes it, and sends Reports to the Hub. It runs only while its System is awake.
_Avoid_: agent (reserved for the AI driving a Harness), exporter, daemon

**Hub**:
The service that receives Reports, stores them in PostgreSQL, derives Conditions, and serves the web dashboard.
_Avoid_: server, backend, center (a Center is a Fleet role)

**Inventory**:
The whole-fleet snapshot of what Fleet declares, which Fleet publishes to the Hub from one commit: the Systems, each System's Applications with their releases, Services, Backup Jobs with their schedules, and Harnesses, and the databases Fleet manages. The Hub's source of desired state for everything but Managed paths.
_Avoid_: Inventory Artifact (Fleet publishes the Inventory to the Hub and Pushes nothing for it), manifest (Fleet's `manifest.json` lists Managed paths and is a separate file), catalog, config

**Install record**:
A data-only record Fleet leaves on a System for each Application, Service, or Backup Job it installs, saying what it installed there. The Collector checks each one against the System; it is what Fleet did, not what Fleet declares.
_Avoid_: receipt, lockfile, Inventory

**Run record**:
The record a Backup Job keeps on its System of its latest run and its latest successful run: when each started and finished, its exit status, and its newest archive.
_Avoid_: heartbeat, ping, log

**Report**:
One payload from a Collector to the Hub: a batch of Vitals samples, Session observations, and the observed state of Managed paths, install records, and run records. Its shape is the versioned wire schema.
_Avoid_: event, metric, ping

**Vitals**:
The small fixed set of host measurements: CPU, memory, disk, load, and uptime. Sampled as a time series so spikes are visible.
_Avoid_: metrics (too broad), telemetry

**Session**:
One running Harness process and its descendants, observed from the process table: Harness, working directory, start and end, and aggregate CPU and memory. Never its transcript or command-line arguments.
_Avoid_: conversation, run

**Condition**:
A problem state the Hub derives for a System from what it receives and what Fleet declared, such as Reports rejected, a Service down, a Backup Job overdue, Drift, a stale System, or low disk. The dashboard shows open Conditions and the Timeline records each one raised and cleared; a later alerting phase delivers them.
_Avoid_: alert (delivery, not the state), finding, incident

**Last seen**:
The most recent time the Hub heard from a System under that System's token, whether it stored the Report or rejected it. A sleeping System shows its last-seen time and a gap; Heimdall does not treat absence alone as failure for Systems tagged `desktop`.
_Avoid_: heartbeat (the mechanism, not the fact), uptime (a Vital)

**Timeline**:
A System's history of Conditions being raised and cleared, newest Condition first. It shows where a System failed and when it recovered, while the dashboard shows where it stands now.
_Avoid_: event feed, event log (a Report is never an event)

**Pairing**:
How a Collector gets its identity: once per System, an operator has the Hub issue a Pairing code bound to the System's name and redeems it on that System, and the Collector keeps the System name and token the Hub returns. Pairing again rotates the token; unpairing revokes it and keeps the System's history.
_Avoid_: enrollment, registration, provisioning (Fleet's install, not Heimdall's identity)

**Pairing code**:
A short, single-use code the Hub issues for one System's Pairing, valid for minutes. It carries no identity until the Hub redeems it.
_Avoid_: token (the lasting credential a Collector sends with each Report), key, password
