---
type: adr
title: ADR-0024 - The Hub fetches list prices daily and adds dated entries, never repricing the past
description: "Besides the bundled prices and the configured overrides, the Hub's price table holds entries the Hub fetches from LiteLLM's public price list as it starts and every 24 hours, or when `heimdall-hub prices update` runs. A model the table has never priced gets an entry from 2020-01-01; a changed price gets a new entry from the day the fetch found it, unless a configured entry prices that tier; an unchanged price adds nothing. No fetch changes or deletes an earlier day's entry, and a failed fetch leaves the table unchanged. When entries tie, configured beats fetched, and fetched beats bundled."
status: accepted
created: 2026-11-20
modified: 2026-11-20
---

# The Hub fetches list prices daily and adds dated entries, never repricing the past

## Context

List-price cost reads one price table ([ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md)).
`serve` rebuilds that table each time it starts, from prices bundled in the Hub (`packages/hub/src/prices.ts`) and an optional overrides file the configuration names.
So pricing a new model takes either a release or an edit to the overrides file followed by a restart.
Until one of those happens, the model's requests are unpriced, and every total that includes them shows only a lower bound.
New models come out more often than Heimdall releases.

LiteLLM publishes a JSON list of model prices at `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.
It is public and needs no credentials.
On 2026-11-20 it listed every model the fleet's Harnesses had used.
For each bundled entry it listed, all 47 of them, every price was identical.
It did not list three older models under undated ids: Claude Opus 4, Claude Opus 4.1, and Claude Sonnet 4.
Its `max_input_tokens` is a model's context window for Anthropic models.
For OpenAI models it is sometimes the window less the output limit (272,000 for gpt-5, whose window is 400,000) and sometimes the whole window (200,000 for o3).

Writing the price table marks every Session's totals for recalculation ([ADR-0016](0016-session-stretches-and-totals-are-stored-and-refreshed.md)).
A write that changes nothing must therefore be skipped.

## Decision

**The price table has three sources.**
Bundled entries ship with the Hub, configured entries come from the overrides file, and fetched entries come from a price list the Hub fetches.
A request is still priced by the entry for its model and prompt tier with the latest `valid_from` on or before the request's time.
When several entries share a model, `valid_from`, and tier, a configured entry wins over a fetched one, and a fetched entry wins over a bundled one.
When `serve` starts, it replaces the bundled and configured entries, as it does today, and leaves the fetched ones in place.

**The Hub fetches LiteLLM's price list as it starts and every 24 hours after that.**
`heimdall-hub prices update` runs the same fetch on demand.
`[prices] source` in the Hub's configuration names the list's URL and defaults to LiteLLM's. Setting it to `off` stops the Hub fetching.
The Hub reads at most 32 MiB of the answer and waits at most 30 seconds for it.

**The Hub keeps only the list's Anthropic and OpenAI models in chat and responses modes, at standard prices.**
From each model it reads:
- the price per token of input, output, cache reads, cache writes, and 1-hour cache writes, each as dollars per million tokens;
- any prompt tier the list names with an `_above_<N>k_tokens` suffix;
- `max_input_tokens`, which it uses as the context window.

It ignores batch, flex, and priority prices.
A key that names a provider path, with a `/`, is skipped.
A key that ends in `-YYYYMMDD` stands for the model without that suffix, unless the list also has the undated key.
A model is skipped when it lacks an input price, an output price, or `max_input_tokens`.
It is also skipped when both its input and output prices are 0, when it fails the rules an overrides entry follows, or when its id is the reserved `unknown`.

**A fetch adds dated entries and never reprices an earlier day.**
For each model and tier it read:
- If the table has no entry for the model at all, the fetch adds one from 2020-01-01, so the model's earlier requests are priced.
- If the entry in force today for that tier has the same prices, the fetch adds nothing. The context window is not compared.
- If the entry in force today is configured, the fetch adds nothing: that tier's price belongs to the operator.
- Otherwise, the fetch adds an entry from today, in UTC.

A new entry for a model the table already prices keeps that model's context window: the window of the entry in force for the tier, or else of the model's base entry.
A fetch never changes or deletes an earlier day's entry.
A model or tier the list drops keeps its entries.
A second fetch on the same day replaces that day's fetched entry for a model and tier.

**A fetch writes all of its entries or none.**
The write takes the lock that migrations and `serve`'s own price load take, and it writes nothing when nothing changed.
A failed fetch leaves the table as it was.
That includes no answer, an error status, an answer over the limit, an answer that is not a JSON object, and a list in which no model fits.
A model that is skipped does not fail the fetch.
In `serve`, a failed fetch is a failed run of a new timer pass, `prices`: `serve` logs a warning, keeps running, and the Hub status page shows the pass failing.
The command exits 1 and writes nothing.

## Considered options

- **Keep bundling prices and release for each new model.** Rejected: a model is unpriced from its first request until the next release and the deploy that follows it.
- **An overrides file kept by hand, which a command loads without a restart.** Rejected as the main path: someone still has to read the pricing pages for each new model. Overrides stay as the correction.
- **Read each provider's pricing page.** Rejected: the pages are documents, not data, and they change shape without notice.
- **Fetch only when someone runs the command.** Rejected: a new model stays unpriced until someone remembers.
- **A systemd timer that runs the command.** Rejected: it needs a provisioner change, and `serve` already runs the other timed passes and reports them on the Hub status page.
- **Take each fetched price from the day it was fetched, even for a model never priced before.** Rejected: the model's requests from before the fetch would stay unpriced, although no earlier price existed to conflict with.
- **Mirror the list, replacing earlier fetched entries.** Rejected: a price change would reprice requests made before it, and a model the list dropped would lose its price.

## Consequences

- The Hub depends on a third-party list for new models and price changes. A wrong price in the list becomes the Hub's price from the day it is fetched, and only a configured entry corrects it.
- A price change is dated the day the Hub first fetches it. Requests between the provider's change and that fetch keep the old price, so a Hub that is down for days dates the change late.
- The first fetch on an existing Hub adds nothing for models whose bundled prices match the list. Where they differ, it adds an entry from that day.
- A model priced from 2020-01-01 at its fetched price is priced at that price for its whole history. That is wrong only for a model whose price changed before the Hub first fetched it.
- Bundled prices remain the starting table for a new Hub and the fallback while fetching is off or failing. Releases may still add or correct bundled entries.
- An overrides file still takes effect at the next start of `serve`.
- The Hub makes one outbound HTTPS request a day. Like the upstream checks ([ADR-0022](0022-services-show-their-version-and-the-hub-checks-upstreams.md)), it sends no credentials.
