---
type: adr
title: ADR-0009 - Collectors pair with the Hub, and tokens live in the Hub's database
description: "An operator pairs each System once: the Hub issues a short single-use Pairing code bound to the System's name, and the Collector redeems it for its System name and token, which it keeps in its state directory. The Hub keeps only token hashes in its database, so no per-System secret is rendered by Fleet."
status: accepted
created: 2026-10-07
modified: 2026-10-09
---

# Collectors pair with the Hub, and tokens live in the Hub's database

## Context

Each Collector authenticates its Reports with a per-System token, and the Hub must know every System's token.
Until now both sides read tokens from their config files: the Collector its own `system` and `token`, the Hub a `tokens` list of `system=token` entries.
Fleet renders config files from templates on a Center, and its renderer cannot produce them: a secret placeholder replaces only a whole value at a dotted path, and one template carries one secret reference for every System it targets. Each Collector needs a different name and token, and each Hub entry joins a name and a secret in one string.
A Collector keeps durable state in its state directory, so an identity it receives once survives every reinstall and upgrade.

## Decision

- **An operator pairs each System once.** On the System that hosts the Hub, `heimdall-hub pair <system>` prints a Pairing code bound to that System's name. On the System itself, `heimdall-collector pair <code>` redeems it with the Hub and keeps the System name and token it receives. Running `pair` again for a paired System rotates its token: the old token works until the new code is redeemed. `heimdall-hub unpair <system>` revokes the token and keeps the System's history.
- **A Pairing code is short, single-use, and short-lived.** It is 8 characters of Crockford base32, shown as `XXXX-XXXX` and read in any case with the dash optional, valid for 10 minutes, and replaced by any later code for the same System.
- **Redemption gives nothing away.** `POST /api/v1/pair` with a code answers the System's name and a new token. Every failure answers the same "invalid or expired code", and failed redemptions are capped at 10 a minute across the Hub. At most 100 guesses fit in a code's life, against 2^40 codes.
- **The Hub keeps only hashes.** Tokens are 32 random bytes, and the Hub stores their SHA-256 hashes, and the hashes of unredeemed codes, in its database. Ingest authenticates a Report by its token's hash. Adding or revoking a System needs no restart.
- **The Collector keeps its identity as state.** `identity.json` in the Collector's state directory, mode 0600, holds the System name, the token, and the origin of the Hub that issued it, and is written only after a successful redemption. `run` refuses to start without it. Heimdall never writes the config files Fleet renders ([ADR-0007](0007-binaries-own-their-service-config-file-holds-settings.md)).
- **A token goes only to the Hub that issued it.** `run` refuses to send when the configured Hub URL's origin differs from the one in `identity.json`, so a wrong URL in the config Fleet renders for every System cannot send their tokens elsewhere. Moving the Hub to a new address means pairing every System again.
- **One way to give a System its identity.** The Collector's `system` and `token` settings and the Hub's `tokens` setting and `--token` option are removed. `collector.toml` holds the Hub's URL, the same on every System. `hub.toml` holds the database URL under `[database] url`, where Fleet's dotted secret path can reach it, and the listener's host and port.

## Considered options

- Tokens rendered by Fleet from per-System 1Password items. Rejected: Fleet's templates cannot render per-System values or a secret inside a string, and the Hub would restart for every new System.
- The Hub's tokens as a `[tokens]` table of whole values, which Fleet can render. Rejected for the Collector's side, which still needs a different name and token per System, and for keeping a secret per System in 1Password that the Hub can issue itself.
- The Collector asks to join and the Hub approves. Rejected: the same two steps in reverse, plus a surface for pending requests.
- Fleet pairs on every install. Deferred: a Collector pairs once, so the step is rare, and Fleet has no cross-System imperative step today. Fleet can run the same two commands later.
- A 6-digit numeric code. Rejected: 20 bits would need a far tighter rate limit to stay unguessable.

## Consequences

A new System needs one operator step on two Systems before it reports.
Wiping a Collector's state directory loses its identity as well as its queue, and the System pairs again.
Moving the Hub to a new address means pairing every System again.
Installs made before pairing re-pair once and move `database` to `[database] url`.
The redeem endpoint is open to the tailnet without a token, so its answers and its rate limit are part of the security contract.
The cap is Hub-wide because the Hub cannot see a caller's address behind Tailscale ingress, so a tailnet peer sending 10 bad codes a minute can hold pairing closed. Pairing fails closed, ingest is unaffected, and a Tailscale ACL is the remedy.
Code hashes are unsalted SHA-256 over 40 bits, so anyone who can read the Hub's database can recover a live code within its 10 minutes. Read access to that database is already trusted: it holds every System's Vitals and history. Token hashes cover 256 bits and stay safe.

## Changelog

- 2026-10-07: Accepted. The Hub side landed in HMD-27 and the Collector side in HMD-28.
- 2026-10-08: Clarification. Read access to the Hub's database, which this decision treats as trusted, now also exposes Session transcripts ([ADR-0012](0012-hub-archives-agent-session-transcripts.md)). The decision is unchanged.
- 2026-10-08: Clarification. `collector.toml` is the same on every System only until a System turns off Session transcript capture, a per-System setting in that file ([ADR-0012](0012-hub-archives-agent-session-transcripts.md)). The decision is unchanged.
- 2026-10-09: Clarification. Transcript capture is off until a System's configuration lists a source, and a source absent on a System is skipped, so one rendered `collector.toml` can still serve every System; it differs only where Systems capture different sources ([ADR-0013](0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)). This replaces the 2026-10-08 clarification. The decision is unchanged.
