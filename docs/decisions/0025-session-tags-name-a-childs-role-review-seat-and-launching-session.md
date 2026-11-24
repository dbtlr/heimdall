---
type: adr
title: ADR-0025 - Session tags name a child's role, review seat, and launching Session
description: "The Hub reads one session tag, a line of shaped key=value pairs at the start of a line in a Session's or subagent's first prompt, and T3's sub-agent preamble when no tag is present. It derives a role, a review seat, and a launching Session from them, resolves the launching Session by its bare id against every Session it holds, and splits list-price cost into main, review by seat, and delegated work, with an untagged subagent taking its nearest tagged ancestor's role. A launching Session also gets a total over its whole tree of launched Sessions."
status: accepted
created: 2026-11-24
modified: 2026-11-24
---

# Session tags name a child's role, review seat, and launching Session

## Context

Session insight ([ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)) splits a Session's main conversation from its subagents, but cannot say what a child was started to do:

- A reviewer and an implementer read alike. The only names for a review seat are prose: a subagent's free-text description, or a T3 thread title in no fixed format.
- A child that T3 Code delegates runs as a top-level Session of its own, often in another Harness or on another System. Nothing in its transcript names the Session that launched it, so its list-price cost never reaches the work that caused it.

Agent orchestrators now write one line at the top of each child brief, on every path that starts a child: built-in subagents, workflow agents, Codex subagents, and T3-delegated children on either Harness:

```text
session-tag: role=review seat=breaker parent=<launching session id>
```

Measured on one System's transcripts in November 2026:

- In a built-in subagent, the tag is the first line of the first user message. In a T3-delegated child, it is the third line, after T3's preamble, `Act as the <role> sub-agent for this task.` On Codex, that message follows a user message holding the `AGENTS.md` instructions.
- Of about 400 T3-delegated Claude Code children, 18 carried a tag. Of about 150 Codex children, 4 did. The rest predate the convention, but every one carried the preamble, which names the role and nothing else.
- Seats in use went beyond the adversarial-review panel: `design-rater`, `exitcritic`, and `design` appeared beside `architect`, `breaker`, and `verifier`.
- The instructions that tell agents to write the tag quote its template mid-sentence, so that text reaches the context of nearly every Session. Claude Code's `last-prompt` records repeat a prompt with its line breaks collapsed, so there a tag runs into the prose after it.

## Decision

- **A session tag is one line in a Session's or subagent's first prompt.** On Claude Code the first prompt is the first user message. On Codex it is the first user message after those Codex injects itself, such as the `AGENTS.md` instructions.
  - The line starts with `session-tag:`, followed by space-separated `key=value` pairs and nothing else.
  - Only the first such line counts. No other record is read for it: not later messages, `last-prompt` records, or thread titles.
  - The keys are:
    - `role`: required.
    - `seat`: read only when `role=review`.
    - `parent`: optional, since an agent that cannot read its own Session id leaves it out.
  - Unknown keys are ignored. A repeated key, a misshapen value, or any text that is not a pair makes the line no tag, and it counts as unreadable.
- **Values are shaped, never validated against a list.**
  - A role or a seat is a lowercase name: a letter followed by letters, digits, and `-`, at most 63 characters. A role or seat the Hub has never seen is kept as written, so a new seat needs no Hub release.
  - `parent` is shaped as a Session id.
  - Nothing else from the prompt is kept, so the views still carry no transcript content: the tag adds shaped identifiers, as commands and skills do today.
- **T3's preamble supplies the role when there is no tag.** A first prompt whose first line is `Act as the <role> sub-agent for this task.` gives the Session that role, with no seat and no parent. A tag wins over the preamble. Each Session and subagent records where its role came from: the tag, the preamble, or neither. A T3 child that missed its tag therefore stays countable instead of reading as main-conversation work.
- **`parent` is a bare Session id, resolved against every Session the Hub holds.**
  - The id is the launching agent's own Harness Session id, with no Harness or System prefix. It links to the one held Session with that id, on any Harness, System, or source.
  - When no Session matches, more than one does, or the id names the Session itself, the Hub keeps the raw id and shows the parent as unresolved. A parent whose transcripts arrive later then resolves without a reparse, and one that was purged or never captured still shows.
  - A subagent's place under its Session stays what its transcript says. Only a Session's tag links one Session to another.
- **Cost splits three ways by role:**
  - **Main** is the main conversation of a Session with no role.
  - **Review** is any conversation whose role is `review`, split by seat, with an unknown seat when the role came from the preamble.
  - **Delegated** covers every other role.

  A conversation with a role takes it from its own tag or preamble. A subagent with neither takes the role of its nearest ancestor that has one, a parent subagent before its Session. With no such ancestor, it counts as delegated. A reviewer's own subagents therefore count as review under its seat.
- **A launching Session gets a tree total beside its own.** It sums the Session's totals and those of every Session whose parent resolves to it, transitively, stopping at any Session already counted. Its own total, subagents included, stays as it is.
  - Like `insight.session_totals`, the tree total has a list-price cost only when every request in the tree is priced. Otherwise it gives a lower bound and a count of unpriced requests.
- **Storage follows the projection's rules:**
  - The role, seat, parent, and the role's source are parsed facts on the Session and subagent rows. Both parsers' versions move forward, so the rebuild reads every tag and preamble the archive already holds.
  - The per-Session split by role and seat is stored and refreshed with the Session's totals ([ADR-0016](0016-session-stretches-and-totals-are-stored-and-refreshed.md)).
  - Parent resolution and the tree total are computed when read, from the stored totals. A launched Session that arrives, or a purge, therefore changes them with no trigger.
  - `insight.sessions` and `insight.subagents` gain the new facts, and new `insight` views expose the split and the tree total. Their columns are documented in the spec as they land.
- **The dashboard shows the split on the Agents page and the Session page:**
  - The Agents page shows the split for its period, with a count of T3 children whose role came from the preamble.
  - The Session page shows the Session's role, seat, and launching Session, lists its launched Sessions, and gives the tree total beside its own.

## Considered options

- **A Harness prefix on `parent`.** It would make matches exact. Rejected: Session ids on both Harnesses are UUIDs, the tags already written would need the bare form anyway, and resolution by id across Harnesses is what links a Claude Code parent to a Codex child.
- **Resolve `parent` only on the child's own System.** Rejected: a child delegated to another System would never reach its launcher.
- **Fixed lists of roles and seats.** Rejected: seats in use already go beyond the review panel. A list would hide them until a Hub release, or fold them into one `other`.
- **Reject a tag with an unknown value.** Rejected for the same reason, and it would recount real reviewers as untagged.
- **Ignore the preamble.** Rejected: hundreds of children that predate the convention would read as main-conversation work, the silent miss the tag exists to remove.
- **Read the role from subagent descriptions or thread titles.** Rejected: both are prose in no fixed format, and keeping them would put prompt text in the views.
- **Direct children only in the tree total.** Rejected: an implementer's own review panel would never reach the Session that started the work.
- **An untagged subagent always counts as delegated.** Rejected: a reviewer's exploration would leave review cost, so review would read low by whatever its seats delegate.

## Consequences

- The tag format is a contract between Heimdall and whatever orchestrator writes it. Changing its prefix, keys, or shapes is a documented change, and a line in the old form counts as untagged rather than misread.
- A tag in a misshapen form counts as unreadable and leaves its conversation untagged. A T3 child that has the preamble keeps its role but loses its seat and parent, so a regression in how briefs are written shows on the Agents page.
- A child whose launcher the Hub does not hold shows a parent id that links nowhere. The archive is the only source of truth, so a launcher purged with `heimdall-hub purge system` leaves its children's parents unresolved.
- Two held Sessions with one id, as when two sources on a System capture the same directory, leave every child naming that id unresolved, rather than guessing.
- A role read from the preamble before the convention carries no seat, so review cost from that period shows under an unknown seat.
- The parser bumps rebuild both Harnesses' archives once, as any parser change does ([ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)).
