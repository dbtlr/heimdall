---
type: adr
title: ADR-0014 - Session insight is a rebuildable projection, read through insight views
description: "The Hub derives Session insight from the transcript archive as a projection at request and tool-call grain, built by a versioned parser per Harness and rebuilt whenever that version changes. Agents and the dashboard read it through one set of SQL views in an insight schema, which carry facts and locators but no transcript content, and which a read-only database role can query. Cost is computed in the views at API list prices, never stored."
status: accepted
created: 2026-10-11
modified: 2026-10-11
---

# Session insight is a rebuildable projection, read through insight views

## Context

[ADR-0012](0012-hub-archives-agent-session-transcripts.md) makes the Hub the durable archive of Session transcripts, stored as written so that later analysis can reprocess it. [ADR-0013](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md) stores them as gzipped chunks of generations in PostgreSQL. Neither says what the derived facts look like, where they live, or how anything reads them.

The facts must be trustworthy. Both supported Harnesses repeat usage in their transcripts:

- Claude Code writes one line per content block, so one API response spans several lines that share a message id, and summing every line overcounts tokens by 1.5 to 1.9 times.
- Codex repeats token-count events, and a forked Session's file replays its parent's history.

A parser that removes these duplicates reproduces the totals each Harness reports itself. Parsers will still be wrong at first, and transcript formats change between Harness versions.

Two readers need the facts:

- Agents studying months of Session history.
- The dashboard's later reports and graphs.

The Hub's dashboard and its records read have no authentication; they rely on a single-person tailnet.

## Decision

- **Derived data is a projection of the archive, and can always be rebuilt from it.** The Hub still stores transcripts as written and parses them afterwards, never on arrival ([ADR-0012](0012-hub-archives-agent-session-transcripts.md)). Each Harness has a parser with a version number. The Hub parses each generation incrementally, from where it last stopped. When a parser's version changes, the Hub drops the rows that parser built and parses that Harness's whole archive again. The archive stays the only source of truth: deleting a generation ([ADR-0013](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)) deletes the rows derived from it, so derived data lives exactly as long as its transcripts. The projection is always what the surviving archive yields. A request or a tool call counts once however many generations or files hold it, keyed by an identity each Harness's parser defines from the transcript, such as Claude Code's message id or Codex's response id, so content stored twice under ADR-0013 is never counted twice. Deleting a generation re-derives the Sessions it touched from whatever still holds them.
- **The projection is kept at request and tool-call grain.** It holds:
  - One row per Session, and one per each of its subagents.
  - One row per API request: time, model, each kind of token, and context used.
  - One row per tool call: time, name, MCP server, or skill.

  Totals are computed from these rows, never stored as the source of truth. Each row carries a locator back to its place in the archive: System, source, path, generation, and byte offset in the generation's uncompressed content.
- **One read model.** A documented set of SQL views in an `insight` schema is the contract every reader uses. Agents query it through a read-only PostgreSQL role, named in the Hub's configuration and created by whoever provisions the database. The Hub grants that role read access to the `insight` schema once the role exists, and nothing else: not transcripts, tokens, or Pairing codes. The dashboard's reports read the same views, so a number has one definition.
- **The views carry facts and locators, never transcript content.** Reading content takes the full database access [ADR-0009](0009-collectors-pair-with-the-hub.md) treats as trusted, such as through a Hub command on the Hub's System that prints a Session's or a request's transcript lines.
- **Cost is computed in the views, never stored.** It is an approximation at API list prices, from a dated price table compiled into the Hub, so it adds no release asset, and the Hub's configuration can add or override entries, dated the same way, so a price change never reprices earlier requests. A request for a model with no known price is unpriced, not free.

## Considered options

- **Store only per-Session totals.** It is smaller and simpler. Rejected: totals cannot show token use and cost over time, context filling up, or which request was running during a Vitals spike, and every new question would need a parser change and a full reparse.
- **Parse on the Collector and send derived numbers.** Rejected for the reasons ADR-0012 gives: nothing could be reprocessed, and every new question would need a Collector release.
- **An HTTP query API on the Hub.** No database credentials would leave the Hub's System. Rejected: every question would need its own endpoint, and until hardening adds authentication it would let anyone on the tailnet run those queries. PostgreSQL authenticates the read-only role, and ADR-0009 already treats database read access as trusted.
- **Full-text search over transcript content in the views.** Rejected for now: it would put content, including any secret an agent read, behind the read-only role. It waits for the hardening that decides how secrets in transcripts are handled.
- **Prices fetched from a provider at runtime.** Rejected: it would add an outbound dependency to a Hub that talks to nothing outside the tailnet. Prices kept only in configuration were also rejected, because every operator would then maintain a whole table.

## Consequences

A parser fix or a price fix loses nothing: the first rebuilds the projection, and the second changes only what the views compute. A full rebuild reads the whole archive, so its cost grows with the archive.

The `insight` views become a contract inside Heimdall. Changing a column that agents or the dashboard read is a deliberate, documented change, not a refactor.

The read-only role sees which Sessions ran, where, with which models and tools, and at what cost, but no prompt, response, or tool output. The dashboard's reports show the same facts under the dashboard's existing trust, a tailnet only its operator can reach, until hardening adds authentication.

A price fix that changes the compiled table needs a Hub release. Until then, a configuration override covers it.

A Harness that changes its transcript format needs a parser release before its new Sessions are counted correctly. A parser version bump then rebuilds that Harness's history under the new rules.
