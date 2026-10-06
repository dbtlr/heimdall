---
description: "Heimdall's domain vocabulary: Collector, Hub, Inventory, Report, Vitals, Session, Condition, Last seen, and Timeline, plus the Fleet terms it borrows."
---

# Glossary

Heimdall observes the Fleet. It borrows Fleet's vocabulary unchanged: **System**, **Center**, **Harness**, **Application**, **Service**, **Backup Job**, **Push**, **Apply**, **Managed path**, and **Drift** mean exactly what the Fleet glossary says. The terms below are Heimdall's own.

## Language

**Collector**:
The process that runs on each System, observes it, and sends Reports to the Hub. It runs only while its System is awake.
_Avoid_: agent (reserved for the AI driving a Harness), exporter, daemon

**Hub**:
The service on Asgard that receives Reports, stores them in PostgreSQL, derives Conditions, and serves the web dashboard.
_Avoid_: server, backend, center (a Center is a Fleet role)

**Inventory**:
The per-System Artifact that Fleet compiles and Pushes, listing what Fleet declares for that System: Services, Backup Jobs, Applications with their selected releases, and Harnesses. The Collector's only source of desired state.
_Avoid_: manifest (Fleet's `manifest.json` lists Managed paths and is a separate file), config

**Report**:
One payload from a Collector to the Hub: a batch of Vitals samples, Session observations, and the observed state of each Inventory entry. Its shape is the versioned wire schema.
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
