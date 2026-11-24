---
type: adr
title: ADR-0025 - Session tags name a started conversation's role, review seat, and launching Session
description: "The Hub reads a session tag, a line of shaped key=value pairs, or T3 Code's sub-agent preamble when no tag is present, from the messages that open a Session or subagent. From them it derives a role, a review seat, and a launching Session. It resolves the launching Session by its bare id against every Session it holds, and splits list-price cost into main, review by seat, and delegated, where a conversation with no role of its own takes the nearest one above it. A launching Session also gets a tree total over every Session it launched, directly or through others."
status: accepted
created: 2026-11-24
modified: 2026-11-24
---

# Session tags name a started conversation's role, review seat, and launching Session

## Context

Session insight ([ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)) splits a Session's main conversation from its subagents. It cannot say what a started conversation was started to do:

- A reviewer and an implementer read alike. The only names for a review seat are prose: a subagent's free-text description, or a T3 thread title in no fixed format.
- A Session that T3 Code delegates runs as a top-level Session of its own, often in another Harness or on another System. Nothing in its transcript names the Session that launched it, so its list-price cost never reaches the work that caused it.

Agent orchestrators now write one line at the top of each brief that starts a conversation, whether it starts a built-in subagent, a workflow agent, a Codex subagent, or a T3-delegated Session on either Harness:

```text
session-tag: role=review seat=breaker parent=<launching session id>
```

Measured on one System's transcripts in November 2026:

- **Where the line sits.** The tag does not always open the brief:
  - In a built-in subagent, the tag is the first line.
  - A workflow agent's brief opens with a harness header line, and the tag follows it, indented.
  - A T3-delegated Session's brief opens with a `[T3 Code: …]` header in its current form, then T3's preamble, `Act as the <role> sub-agent for this task.`, then the tag.
  - On Codex, the brief follows user messages that Codex injects itself, such as the `AGENTS.md` instructions, `<environment_context>`, and `<recommended_plugins>`. Their order varies, and nothing marks them as injected.
- **Codex subagents.** A Codex subagent's brief is encrypted in both its own rollout and its parent's. A forked Codex subagent also replays its parent's messages before its own. No Codex subagent's tag is readable.
- **How many carry it.** Of about 1,400 T3-delegated Claude Code Sessions, 238 carried a tag; of about 540 on Codex, 7 did. Every one carried the preamble, which names the role and nothing else. Those without a tag predate the convention.
- **Seats in use.** They went beyond the adversarial-review panel: `design-rater`, `exitcritic`, and `design` appeared beside `architect`, `breaker`, and `verifier`.
- **The template reaches every context.** The instructions that tell agents to write the tag quote its template mid-sentence, so that text reaches the context of nearly every Session. Claude Code's `last-prompt` records repeat a prompt with its line breaks collapsed, so there a tag runs into the prose after it.

## Decision

- **The tag and the preamble are read from a conversation's opening messages.** These are its user messages before its first response. On a Codex fork, only its own messages count, never those it replays from its parent. Nothing after the first response is read for them, nor any `last-prompt` record or thread title.
  - When generations disagree, the opening messages with the earliest time win. These facts are re-derived from what survives a delete, like every other fact.
- **A session tag is a line of the opening messages that is a well-formed tag.**
  - **Form.** With leading whitespace removed, the line starts with `session-tag:`, followed by space-separated `key=value` pairs and nothing else.
  - **Keys:**
    - `role` is required.
    - `seat` is kept only when `role=review`. A review tag without one has an unknown seat.
    - `parent` is optional, since an agent that cannot read its own Session id leaves it out.
  - **Unknown keys** are ignored.
  - **Malformed lines.** A repeated key, a misshapen role, seat, or parent, or any text that is not a pair makes the line no tag. It counts as unreadable, and the next line is tried.
  - **Precedence.** The first well-formed tag counts.
- **Values are shaped, never validated against a list.**
  - A role or a seat is a lowercase name: a letter followed by letters, digits, and `-`, at most 63 characters. A role or seat the Hub has never seen is kept as written, so a new seat needs no Hub release.
  - `parent` is shaped as a Session id.
  - Nothing else from the prompt is kept, so the views still carry no transcript content: the tag adds shaped identifiers, as commands and skills do today.
- **T3's preamble supplies the role when there is no tag.**
  - The first opening line that reads exactly `Act as the <role> sub-agent for this task.`, apart from surrounding whitespace, gives the conversation that role, held to the same shape, with an unknown seat when the role is `review` and no parent. A tag wins over the preamble.
  - Each Session and subagent records where its role came from: the tag, the preamble, or neither. A T3-delegated Session that missed its tag therefore stays countable instead of reading as main-conversation work.
- **A Codex subagent has no readable tag.** It takes its role only from the nearest one above it, as the split below defines.
- **`parent` is a bare id, resolved against everything the Hub holds.**
  - The id is the launching agent's own Harness id, with no Harness or System prefix. It resolves to the one held Session with that id, on any Harness, System, or source.
  - When the id names a held Codex subagent's thread instead, as when a Codex subagent launches a Session, it resolves to that subagent's Session.
  - When nothing matches, more than one Session does, or the id names the Session itself, the Hub keeps the raw id and shows the parent as unresolved. A parent whose transcripts arrive later then resolves without a reparse, and one that was deleted or never captured still shows.
  - A subagent's place under its Session stays what its transcript says. Only a Session's tag links one Session to another, so a subagent's `parent` is kept but links nothing.
- **Cost splits three ways by role:**
  - **Main**: a Session's main conversation when the Session has no role.
  - **Review**: any conversation whose role is `review`, split by seat.
  - **Delegated**: every other conversation, including a subagent with no role anywhere above it.

  Each conversation's **effective role** is its own role when it has one. Otherwise it takes the effective role of the conversation above it: its parent subagent, then its Session's main conversation. A conversation with no effective role is main when it is a Session's main conversation, and delegated otherwise. A reviewer's own subagents therefore count as review under its seat.
- **A launching Session gets a tree.** Its tree is the Session and every Session whose parent resolves to it, transitively, stopping at any Session already counted.
  - Its tree total sums the members' totals beside the Session's own total, which, subagents included, stays as it is.
  - Like `insight.session_totals`, the tree total has a list-price cost only when every request in the tree is priced. Otherwise it gives a lower bound and a count of unpriced requests.
  - The tree's members are readable, so the split over a tree is the sum of its members' splits.
- **Storage follows the projection's rules.**
  - **Parsed facts.** The role, seat, parent, and the role's source are parsed facts on the Session and subagent rows. Both parsers' versions move forward, so the rebuild reads every tag and preamble the archive already holds.
  - **Stored split.** The per-Session split by effective role and seat is stored and refreshed with the Session's totals ([ADR-0016](0016-session-stretches-and-totals-are-stored-and-refreshed.md)). That split reads the subagent rows, so a change to a subagent row marks its Session stale, as a change to a Session row already does.
  - **Computed on read.** Each conversation's effective role and seat, parent resolution, and the tree are computed when read: the first two from the parsed facts, the tree from the stored totals. A reader that prices a period's requests, as the Agents page does for Sessions that cross the period's edge, splits them by the conversation's effective role. A Session that arrives later, or a delete, therefore changes these with no trigger.
  - **Views.** `insight.sessions` and `insight.subagents` gain the parsed facts and the effective role, and new `insight` views expose the split, parent resolution, and the tree. Their columns are documented in the spec as they land.
- **The dashboard shows the split on the Agents page and the Session page.**
  - The Agents page shows the split for its period, with a count of T3-delegated Sessions whose role came from the preamble.
  - The Session page shows the Session's role, seat, and launching Session, lists the Sessions it launched, and gives the tree total beside its own.

## Considered options

- **A Harness prefix on `parent`.** It would make matches exact. Rejected for three reasons: Session ids on both Harnesses are UUIDs, the tags already written would need the bare form anyway, and resolving by id across Harnesses is what links a Claude Code parent to a Codex Session.
- **Resolve `parent` only on the launched Session's own System.** Rejected: a Session delegated to another System would never reach its launcher.
- **Fixed lists of roles and seats.** Rejected: seats in use already go beyond the review panel. A list would hide them until a Hub release, or fold them into one `other`.
- **Reject a tag with an unknown value.** Rejected for the same reason, and it would recount real reviewers as untagged.
- **Read the tag only at the start of a line in the first user message.** Rejected: workflow agents indent it after a header, T3 puts a header before it, and Codex puts its injected messages first. No way of recognizing those injected messages is stable.
- **Ignore the preamble.** Rejected: over a thousand T3-delegated Sessions that predate the convention would read as main-conversation work. That is the silent miss the tag exists to remove.
- **Read the role from subagent descriptions or thread titles.** Rejected: both are prose in no fixed format, and keeping them would put prompt text in the views.
- **Direct launches only in the tree total.** Rejected: an implementer's own review panel would never reach the Session that started the work.
- **A conversation with no role of its own always counts as delegated.** Rejected: a reviewer's exploration would leave review cost, so review would read low by whatever its seats delegate.

## Consequences

- **The tag format is a contract** between Heimdall and whatever orchestrator writes it. Changing its prefix, keys, or shapes is a documented change, and a line in an old form counts as untagged rather than misread.
- **Brief-writing regressions show.**
  - A misshapen tag counts as unreadable and leaves its conversation untagged.
  - A T3-delegated Session that has the preamble keeps its role but loses its seat and parent, so a regression in how briefs are written shows on the Agents page.
- **Opening text can carry a tag by accident.** Every opening message is read, so instructions injected into one would be read as a tag if they held a well-formed tag line with real values. The template the instructions quote today is mid-sentence and names placeholders, so it is no tag.
- **Unresolved parents.**
  - A Session whose launcher the Hub does not hold shows a parent id that links nowhere. A launcher whose transcripts are deleted, through `heimdall-hub transcripts delete` or `purge system --transcripts`, leaves the Sessions it launched with an unresolved parent.
  - Two held Sessions with one id, as when two sources on a System capture the same directory, leave every Session naming that id unresolved, rather than guessing.
  - While a delete re-derives a Session, the views hide it ([ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)). The Sessions it launched then show their parent as unresolved, and trees that hold it leave it out, until it reappears.
- **Codex review seats inherit.** A Codex subagent's review seat is never seen. It counts under the role above it, so Codex panels run as native subagents show their cost under their launcher's role, not by seat.
- **Older review cost has no seat.** A role read from the preamble carries no seat, so review cost from before the convention shows under an unknown seat.
- **One rebuild.** The parser bumps rebuild both Harnesses' archives once, as any parser change does ([ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)).
