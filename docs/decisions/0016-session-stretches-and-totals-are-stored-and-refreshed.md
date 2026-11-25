---
type: adr
title: ADR-0016 - Session stretches and totals are stored, and the Hub refreshes them
description: "The Hub stores each Session's stretches and totals, cost included, instead of computing them on every read. Triggers mark the Sessions a change can alter stale in the transaction that makes it, and the Hub's refresh stores what the rules compute for the stale Sessions every 15 seconds. The insight views read the stored rows, so they can lag a change by one refresh. This supersedes ADR-0014's rule that totals and cost are never stored; the rest of ADR-0014 holds."
status: accepted
created: 2026-10-14
modified: 2026-11-25
---

# Session stretches and totals are stored, and the Hub refreshes them

## Context

[ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md) computes Session totals and cost in the `insight` views on every read, and never stores them, so a price fix or a rebuild needs nothing redone. The links between Sessions and Harness processes ([spec](../spec.md#linking-harness-processes-to-sessions)) are computed the same way.

On the live archive in October 2026, about 200,000 requests in 800 Sessions, that made the dashboard unusable:

- `insight.session_stretches` links every request in the range one by one before it can tell which requests start a stretch.
- `insight.session_totals` prices every request of a Session each time it is read.
- The 24-hour Fleet overview took 22 seconds and the 7-day overview reached the 30-second statement timeout. Pricing each Session once per page instead of once per stretch (HMD-96) brought them to 6 and 13 seconds; the linking was left. The cost grows with agent activity, not with the number of Systems.

## Decision

- **The Hub stores each Session's stretches and totals**, in `stored_session_stretches` and `stored_session_totals`, and the totals split by model in `stored_session_model_totals`, which the refresh replaces with the totals. The rules stay where they were, in the `computed_session_stretches`, `computed_session_totals`, and `computed_session_model_totals` views, so a stored row is always what the rules gave.
- **A change marks the Sessions it can alter stale**, in the same transaction, through triggers on everything the rules read:
  - a Session's requests and its Session row,
  - the end of a delete's re-derivation,
  - a Harness process, its readings and their rollups,
  - Vitals buckets,
  - the price table, which marks only totals,
  - a parser switch.

  A change to a request or a Session row marks its Session by key. Any other change marks a range: the Sessions of a System and Harness with a request near or after it, every Session's totals for a price change, or every Session of a Harness for a parser switch. The refresh's pick reads which Sessions a range covers in its own snapshot, not the writer's, so a Session a parse commits while the change is still open is covered too. Loading the price table at start writes it only when a price changed.
- **The refresh stores what the rules give for the stale Sessions**, those that failed fewest times and then those with the latest requests first. Each Session is its own transaction, so one that cannot be refreshed, such as one too large for the statement timeout, holds up no other: it is tried again behind the rest, left after 3 tries until it is marked again, and named in a warning. `serve` runs the refresh on its own 15-second timer, for at most 10 seconds a run, so a backlog such as every Session after a parser switch drains over several runs.
- **The `insight.session_stretches`, `insight.session_totals`, and `insight.session_model_totals` views read the stored rows.** The first two keep the columns they had; `insight.session_model_totals` is new, with one row per Session and model. All three hide a Session a delete is deriving again at once, as every view does.
- **Cost is still computed by the views' rules, at the prices in force.** A price change marks every Session's totals stale, so a price fix reprices every stored total within a few refreshes, with no rebuild.

## Considered options

- **Compute stale Sessions on read.** The views would union the stored rows with the rules' rows for the Sessions not yet refreshed, so a read never lags. Rejected: the Sessions running now are stale between nearly every pair of refreshes, and computing them on the live archive cost 1 to 2 seconds a page.
- **Optimize the views and keep computing on read.** Linking per Session instead of per request would cut the time several-fold. Rejected: reads would still grow with the activity in the range.
- **Cache in the dashboard.** Rejected: it hides the cost from the first reader, and every other reader of the views still pays it.

## Consequences

The views that read stored rows can lag a change by one refresh, about 15 seconds. That includes a new Session, which appears once refreshed. The dashboard refreshes its pages on the same period. A backlog lags longer:

- The migration that first added the stored rows marks every Session stale, so for the first minute or two after that upgrade the views missed the Sessions not yet stored. The migration that added the model totals fills them from the rules at once for every Session that has stored totals, so the two are present together.
- A parser switch marks every Session of its Harness. Until the refresh reaches a Session, these views show what the earlier version derived, while `insight.sessions` and `insight.requests` already show the new one. A rebuild also marks each Session as its rows are written.

The views that still compute on read, `insight.requests` and `insight.main_conversation_totals`, can briefly disagree with `insight.session_totals` until the refresh: a Session's requests can sum to more than its stored total. Each number still has one definition.

A stale Session's stretches stay as they were until the refresh stores the new ones. A refresh of a Session with thousands of requests takes about a second, and `serve` spends about 2 seconds a run on the Sessions that are active.

A missing trigger would leave a stored row behind the rules with nothing to show it. Each trigger therefore has a test that changes what it watches and checks the Session is marked.

## Changelog

- 2026-10-14: Accepted with the change that builds it (HMD-97). On a copy of the live archive, after HMD-96, the 24-hour overview went from 6 seconds to about 0.1 and the 7-day overview from 13 seconds to about 0.4.
- 2026-10-18: Addendum. Per-Session model totals are stored and refreshed with Session totals (HMD-143). The decision is unchanged.
- 2026-11-24: Addendum. [ADR-0025](0025-session-tags-name-a-started-conversations-role-seat-and-launcher.md) stores each Session's list-price cost split by role and seat with its totals. That split reads the subagent rows and the tool call that spawned each subagent, through a copy of the call's conversation that triggers keep on the subagent row, so both join what a change marks a Session stale by key, beside its requests and its Session row. The decision is unchanged.
- 2026-11-25: Addendum. Each Session's cost is also stored in five-minute intervals per model, in `stored_session_request_intervals`, which the refresh replaces with the other totals (HMD-324). A read of part of a Session through `session_window_model_totals`, such as a chart bar or a period that cuts it, takes the stored intervals wholly inside its window and prices only the requests in the partial intervals at its edges. It prices every request in the window instead unless `session_totals_current` holds: the Hub holds the Session's totals and they are stale neither by key nor by a range. Both window functions ask that one rule, and the project page's tool counts keep an inline copy of it, so the window agrees with `insight.requests` until the refresh. Five minutes divides every time-zone offset in use, so local hours and days end on an interval's edge. Each Session's first and last request are kept in `stored_session_spans`, which a trigger keeps equal to the bounds of its stored stretches and `insight.session_spans` reads. On 10,000 synthetic Sessions of 1,000 requests each, the intervals hold about 46 rows a Session and add about 10 milliseconds to each Session's refresh, as much as its split by role. Each Session's bursts, its requests joined where at most 5 minutes apart for the Session and for each subagent, are stored in `stored_session_bursts`, which `insight.session_bursts` reads, a subagent's own bursts only for a subagent `insight.subagents` lists, so a count of a period's subagents reads the bursts alone; a change to a subagent's row marks its Session stale, and its tool calls counted by tool, with each tool's first and last call, in `stored_session_tool_totals` (HMD-325). The refresh replaces both with the other totals. Bursts have no live fallback: a read of them, such as the project page's lanes, active time, subagent count, and its choice of which Sessions to list branches and tools for, lags new requests until the refresh. A window's tool counts, read through `session_window_tool_totals`, take the stored counts while every tool's calls lie wholly inside or outside the window, and count the Session's calls in the window instead when a tool's calls cross its edge or `session_totals_current` does not hold. A tool call arrives in the transaction that writes its Session's row, which marks the Session stale by key. On 10,000 synthetic Sessions with about 82,000 subagents and 10 million requests, migrations 53 to 56 took about 3.5 minutes together: about 2 minutes to fill the intervals and 1.5 minutes to fill the bursts and tool counts. The decision is unchanged.
- 2026-11-25: Addendum. The five-minute intervals are also split by the class and seat of the conversation that made their requests, as `insight.conversation_roles` defines it, so a period's split by role reads a Session crossing its edge as the model totals over a window read it, through `session_window_role_totals` (HMD-327). The split is a list on each model's row, so a read by model reads as many rows as before, and a request of a conversation with no class is in no entry, as in the stored split. `session_windows_model_totals` reads a Session's model totals in many consecutive windows at once, such as a chart's bars, pricing only the intervals an edge off a five-minute boundary cuts. The refresh fills the list with the intervals, unchanged. The role of each conversation joins by a key PostgreSQL can hash, with the nested loop it would plan for it switched off in the two functions that join, so the cost grows with a Session's subagents, not their square. On 10,000 synthetic Sessions with 80,000 subagents and 10 million requests, migration 58 took about 2 to 4 minutes (133 seconds with a warm cache). Refreshing one Session of 1,000 requests and 10 subagents takes about 0.15 seconds, and one of 42,000 requests and 4,000 subagents about 9 seconds, of which the intervals take 0.75. The decision is unchanged.
- 2026-11-25: Addendum. Each Session has one integer key in `session_keys`, which every stored table of it carries as `session_key`, a reference that deletes on cascade (HMD-328). The Session's first refresh assigns the key. Later refreshes and re-derivation replace its stored rows and keep the key. A purge deletes it, and so does a transcript delete that leaves the Session no generation, as [ADR-0013](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md) requires, since nothing derived outlives its transcript; the stored rows go with it either way. A Session that keeps a generation keeps its key. A read of thousands of Sessions, such as the project page's lanes and tools, matches one integer per row against a list of keys instead of joining on the four-part key, which the planner estimates at a row or so. The `projected_` tables, the requests, and the `insight` views keep the four-part key, and so do the window functions, which read one Session at a time by its primary key. The totals row also holds a summary that a period's read needs once per Session: how many subagents have bursts of their own, the first and last of those bursts, and the first and last tool call. A period that holds all of a Session's subagent bursts counts each of them, and one that holds all of its tool calls has no tool crossing its edge, so only a Session at the period's edge has its rows read again. On 10,000 synthetic Sessions with 100,000 subagents and 10 million requests, migration 59 took about 11 seconds, most of it writing the key into the five-minute intervals. The decision is unchanged.
