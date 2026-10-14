---
type: adr
title: ADR-0016 - Session stretches and totals are stored, and the Hub refreshes them
description: "The Hub stores each Session's stretches and totals, cost included, instead of computing them on every read. Triggers mark the Sessions a change can alter stale in the transaction that makes it, and the Hub's refresh stores what the rules compute for the stale Sessions every 15 seconds. The insight views read the stored rows, so they can lag a change by one refresh. This supersedes ADR-0014's rule that totals and cost are never stored; the rest of ADR-0014 holds."
status: accepted
created: 2026-10-14
modified: 2026-10-14
---

# Session stretches and totals are stored, and the Hub refreshes them

## Context

[ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md) computes Session totals and cost in the `insight` views on every read, and never stores them, so a price fix or a rebuild needs nothing redone. The links between Sessions and Harness processes ([spec](../spec.md#linking-harness-processes-to-sessions)) are computed the same way.

On the live archive in October 2026, about 200,000 requests in 800 Sessions, that made the dashboard unusable:

- `insight.session_stretches` links every request in the range one by one before it can tell which requests start a stretch.
- `insight.session_totals` prices every request of a Session each time it is read.
- The 24-hour Fleet overview took 22 seconds and the 7-day overview reached the 30-second statement timeout. Pricing each Session once per page instead of once per stretch (HMD-96) brought them to 6 and 13 seconds; the linking was left. The cost grows with agent activity, not with the number of Systems.

## Decision

- **The Hub stores each Session's stretches and totals**, in `stored_session_stretches` and `stored_session_totals`. The rules stay where they were, in the `computed_session_stretches` and `computed_session_totals` views, so a stored row is always what the rules gave.
- **A change marks the Sessions it can alter stale**, in the same transaction, through triggers on everything the rules read:
  - a Session's requests and its Session row,
  - the end of a delete's re-derivation,
  - a Harness process, its readings and their rollups,
  - Vitals buckets,
  - the price table, which marks only totals,
  - a parser switch.

  A change to a request or a Session row marks its Session by key. Any other change marks a range: the Sessions of a System and Harness with a request near or after it, every Session's totals for a price change, or every Session of a Harness for a parser switch. The refresh reads which Sessions a range covers in its own snapshot, not the writer's, so a Session a parse commits while the change is still open is covered too. Loading the price table at start writes it only when a price changed.
- **`refresh_session_insight` stores what the rules give for the stale Sessions**, those with the latest requests first. `serve` runs it on its own 15-second timer, in batches of 5 Sessions, for at most 10 seconds a run, so a backlog such as every Session after a parser switch drains over several runs.
- **The `insight.session_stretches` and `insight.session_totals` views read the stored rows.** They keep their columns, and they hide a Session a delete is deriving again at once, as every view does.
- **Cost is still computed by the views' rules, at the prices in force.** A price change marks every Session's totals stale, so a price fix reprices every stored total within a few refreshes, with no rebuild.

## Considered options

- **Compute stale Sessions on read.** The views would union the stored rows with the rules' rows for the Sessions not yet refreshed, so a read never lags. Rejected: the Sessions running now are stale between nearly every pair of refreshes, and computing them on the live archive cost 1 to 2 seconds a page.
- **Optimize the views and keep computing on read.** Linking per Session instead of per request would cut the time several-fold. Rejected: reads would still grow with the activity in the range.
- **Cache in the dashboard.** Rejected: it hides the cost from the first reader, and every other reader of the views still pays it.

## Consequences

The two views can lag a change by one refresh, about 15 seconds. That includes a new Session, which appears once refreshed. The dashboard refreshes its pages on the same period. A backlog lags longer:

- The migration that adds the stored rows marks every Session stale, so for the first minute or two after an upgrade the views miss the Sessions not yet stored.
- A parser switch marks every Session of its Harness. Until the refresh reaches a Session, these two views show what the earlier version derived, while `insight.sessions` and `insight.requests` already show the new one. A rebuild also marks each Session as its rows are written.

The views that still compute on read, `insight.requests` and `insight.main_conversation_totals`, can briefly disagree with `insight.session_totals` until the refresh: a Session's requests can sum to more than its stored total. Each number still has one definition.

A stale Session's stretches stay as they were until the refresh stores the new ones. A refresh of a Session with thousands of requests takes about a second, and `serve` spends about 2 seconds a run on the Sessions that are active.

A missing trigger would leave a stored row behind the rules with nothing to show it. Each trigger therefore has a test that changes what it watches and checks the Session is marked.

## Changelog

- 2026-10-14: Accepted with the change that builds it (HMD-97). On a copy of the live archive, after HMD-96, the 24-hour overview went from 6 seconds to about 0.1 and the 7-day overview from 13 seconds to about 0.4.
