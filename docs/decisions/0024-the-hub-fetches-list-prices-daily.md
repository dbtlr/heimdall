---
type: adr
title: ADR-0024 - The Hub fetches list prices daily and adds dated entries, never repricing an earlier day
description: "The Hub's price table has three sources: configured overrides, entries fetched from LiteLLM's public price list, and bundled prices. A request takes the highest prompt tier its prompt reaches, and within that tier the first source with an entry in force, configured first, then fetched, then bundled, whatever their dates. The Hub fetches the list when serve starts and again once a day, and `heimdall-hub prices update` fetches it on demand. A model the table has never priced gets fetched entries from 2020-01-01. A tier whose price changed gets a fetched entry from the day the change was found. A tier with a configured entry in force is left alone, and so is an unchanged price. No fetch changes or deletes an entry from an earlier day, and a failed fetch leaves the fetched entries unchanged. This supersedes ADR-0014's prices compiled into the Hub."
status: accepted
created: 2026-11-20
modified: 2026-11-20
---

# The Hub fetches list prices daily and adds dated entries, never repricing an earlier day

## Context

List-price cost reads one price table.
[ADR-0014](0014-session-insight-is-a-rebuildable-projection-read-through-insight-views.md) compiles that table into the Hub and lets the configuration override entries in it.
ADR-0014 rejected fetching prices at runtime because the fetch would add an outbound dependency.
[ADR-0022](0022-services-show-their-version-and-the-hub-checks-upstreams.md) has since given the Hub outbound checks of release upstreams.
`serve` rebuilds the table each time it starts, from the bundled prices (`packages/hub/src/prices.ts`) and an optional overrides file.
So pricing a new model takes either a release or an edit to the overrides file followed by a restart.
Until one of those happens, the model's requests are unpriced, and every total that includes them shows only a lower bound.
New models come out more often than Heimdall releases.

LiteLLM publishes a JSON list of model prices at `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.
It is public and needs no credentials.
On 2026-11-20 it listed every model the fleet's Harnesses had used except three older Anthropic models: Claude Opus 4, Claude Opus 4.1, and Claude Sonnet 4.
For each bundled entry it listed, 47 in all, every price and prompt tier was identical.
It also listed gpt-6.2-sol and other models that the bundled table does not price.
Its `max_input_tokens` is a model's context window for Anthropic models.
For OpenAI models it is sometimes the window less the output limit: 272,000 for gpt-5, whose window is 400,000, and 922,000 for gpt-6.1-sol, whose window is 1,050,000.
For o3 it is the whole window, 200,000.

The views choose a price by prompt tier, then latest `valid_from`, then a configured entry before a bundled one.
Under that order, a release that bundles a model at a later date would reprice every request that a fetched entry had priced.
An override dated before a fetched entry would lose to it.
Ordering the sources by date cannot keep both of those right.

Writing the price table marks every Session's totals for recalculation ([ADR-0016](0016-session-stretches-and-totals-are-stored-and-refreshed.md)).
A write that changes nothing must therefore be skipped.

## Decision

**Within a prompt tier, the source decides before the date.**
Configured entries come from the overrides file, fetched entries from a price list the Hub fetches, and bundled entries ship with the Hub.
An entry is in force for a request when its `valid_from` is on or before the request's time and the request's prompt reaches its tier.
Of the entries in force for the request's model, the highest tier applies, as it does today.
Within that tier, the first source with an entry in force applies, in the order configured, fetched, bundled, and within that source the latest `valid_from`.
In each tier, a configured entry therefore wins over fetched and bundled entries of any date until the operator removes it, and a fetched entry wins over bundled entries of any date.
Tiers stay independent: an override replaces only the tiers it names, as it does today.
Fetched entries live in a table of their own, `fetched_model_prices`, beside `model_prices`, which holds the bundled and configured entries.
When `serve` starts, it replaces `model_prices` whole, as it does today, and never touches the fetched entries.
A Hub rolled back to a release before this decision therefore cannot delete them.
The migration that adds the table and changes the views marks every Session's totals for recalculation, since the new order can change which price applies. The new table gets the same trigger as `model_prices`, so each later fetch that writes marks them too.

**The Hub fetches LiteLLM's price list when `serve` starts and again once a day.**
`serve` runs a `prices` pass every hour.
The pass fetches the list only when this process has had no successful fetch in the last 24 hours, so a failed fetch is tried again within the hour.
`heimdall-hub prices update` loads the bundled and configured entries, as `serve` does when it starts, then runs the same fetch.
`[prices] source` in the Hub's configuration names the list's URL and defaults to LiteLLM's.
Setting it to `off` stops the fetch; `prices update` then only loads the bundled and configured entries.
`serve` loads the bundled and configured entries before the pass first runs.
The Hub waits at most 30 seconds for the answer and reads at most 32 MiB of it.

**The Hub reads only the list's Anthropic and OpenAI models in chat and responses modes, at standard prices.**
For each model it reads these fields:
- the per-token prices of input, output, cache reads, cache writes, and 1-hour cache writes, which it converts to dollars per million tokens;
- each prompt tier the list names with an `_above_<N>k_tokens` suffix;
- `max_input_tokens`, which it takes as the context window of a model the table has never priced.

It ignores batch, flex, and priority prices.
It also ignores cache-write TTLs that no Harness reports, such as 12 hours.
It skips a key that holds a `/`, which names a provider path.
A key that ends in `-YYYYMMDD` stands for the model without that suffix, unless the list also has the undated key, which always wins. Of several dated keys, the latest date wins.
An id with a dashed date, such as `o3-2025-04-16`, is a model of its own.
The Hub skips a model in any of these cases:
- it lacks an input price, an output price, or `max_input_tokens`, or names a tier without both;
- both its input and output prices are 0;
- it fails the rules an overrides entry follows, the reserved id `unknown` included;
- a price, in any tier and of any kind, is over $10,000 per million tokens, as a unit error would be, whether or not the table prices the model;
- a price differs from the model's price in force for the same tier and kind of token by more than 100 times either way, as a unit error would. Only two present, nonzero prices are compared this way, and a tier whose entry in force today is configured is not compared, since it gets nothing.

A tier that lacks a cache price the model's base has keeps that price absent, so a request in that tier with that kind of token is unpriced, never guessed.

**A fetch adds dated entries tier by tier, and never reprices an earlier day.**
The fetch works out the entries it wants for each model: one for each tier the list gives.
For a tier the table has in force that the list no longer names, it wants an entry at the list's price for a prompt one token over that tier's threshold, so a dropped or moved tier stops applying.
It compares each wanted entry with the entry in force today at exactly that tier, from any source, by the rule above; a tier with no such entry counts as changed.
- **A model with no entry at all** gets its wanted entries from 2020-01-01, so its earlier requests are priced.
- **A tier with a configured entry in force today** gets nothing: its price belongs to the operator.
- **A tier whose prices match** gets nothing. The context window is not compared.
- **Any other tier** gets its wanted entry from today, in UTC.

A new entry for a model the table already prices keeps the context window of the tier's entry in force today, or else of the model's base entry in force today, or else the list's.
A fetch never changes or deletes an entry from an earlier day.
A second fetch on the same day that finds a different price replaces that day's fetched entry for the tier.
A model the list drops keeps its entries.

**A fetch reads the table and writes its entries in one transaction, or does nothing.**
It takes the lock that migrations and `serve`'s own price load take before it reads the prices in force.
It writes nothing when it adds no entry, so it marks no totals for recalculation.
A failed fetch leaves `fetched_model_prices` as it was.
A fetch fails when it gets no answer, a redirect from HTTPS to plain HTTP, a status other than 200, an answer over the limit, an answer that is not a JSON object, or a list in which no model fits.
A skipped model does not fail the fetch.
In `serve`, a failed fetch is a failed run of the `prices` pass: `serve` logs a warning, keeps running, and the Hub status page shows the pass failing.
The command prints why and exits 1. The bundled and configured entries it loaded first stay loaded.

## Considered options

- **Keep bundling prices and release for each new model.** Rejected: a model is unpriced from its first request until the next release and the deploy that follows it.
- **An overrides file kept by hand, loaded by a command without a restart.** Rejected as the main path: someone still has to read the pricing pages for each new model. Overrides stay as the correction, and `prices update` loads an edited file without a restart.
- **Read each provider's pricing page.** Rejected: the pages are documents, not data, and they change shape without notice.
- **Fetch only when someone runs the command.** Rejected: a new model stays unpriced until someone remembers.
- **A systemd timer that runs the command.** Rejected: it needs a provisioner change, and `serve` already runs the other timed passes and reports them on the Hub status page.
- **Order the sources by date, with source only breaking ties.** Rejected: a release that bundles a fetched model at a later date would reprice its history, and an override dated before a fetched entry would lose to it.
- **Order by source before tier, so the first source with any entry in force for the model prices the whole request.** Rejected: an override with only a base price would take a tiered model's long prompts off their tier prices, and an override that names some tiers would leave it unclear which tiers a fetch may add.
- **Fetched entries dated at the fetch's instant, not its day.** Rejected: an override dated that day would then start before the fetched entry. Prices stay day-granular everywhere, at the cost of repricing requests made earlier on the day of a change.
- **Take each fetched price from the day it was fetched, even for a model never priced before.** Rejected: the model's requests from before the fetch would stay unpriced, although no earlier price existed to conflict with.
- **Fetch only the models that appear in projected requests.** Rejected: a new model would be priced only after its first request had been parsed and the next fetch had run. Price changes in the list are rare enough that keeping all of its Anthropic and OpenAI models costs little recalculation.
- **Mirror the list, replacing earlier fetched entries.** Rejected: a price change would reprice requests made before it, and a model the list dropped would lose its price.

## Consequences

- The Hub depends on a third-party list for new models and price changes. A wrong price in the list becomes the model's price from the day it is fetched, or for its whole history when the model is new. An override for the tier corrects it at any date, because a configured entry wins in its tier.
- A price change is dated the day the Hub first fetches it. Requests between the provider's change and that fetch keep the old price, and requests earlier on the fetch day take the new one.
- The first fetch on an existing Hub adds nothing for models whose bundled prices match the list. Where they differ, it adds entries from that day.
- A model priced from 2020-01-01 is priced at its first fetched price for its whole history. That is wrong for a model whose price changed before the Hub first fetched it, or whose first list entry was wrong. The $10,000 ceiling refuses a unit slip that lands above it, such as a per-million price written as per-token, before it can price that history. A first price wrong by less than the ceiling still prices the model's history, and when it is more than 100 times off, the 100-times check then refuses every later correct price, with a warning on each fetch, until an override corrects it.
- Once a tier has a fetched entry, a release that changes its bundled price no longer applies to it, except for requests from before that entry. A release that adds, changes, or removes a bundled entry still reprices the requests that entry prices, as it always has. A bundled tier added for a model the list carries without that tier applies from its date until the next fetch retires it.
- Bundled prices are the starting table for a new Hub and cover models the list does not carry. A bundled entry applies to a request only when no fetched or configured entry is in force in its tier.
- The window of a model first priced by a fetch is the list's `max_input_tokens`. For OpenAI models that is often below the real window. It shows only where the Harness recorded no window of its own, and a configured entry corrects it.
- Fetched entries are history that cannot be rebuilt from the Hub's code and configuration. A Hub whose database is lost and restored without them dates every price change from its next fetch.
- An override now lasts until it is removed, even when a later release bundles a newer price for its tier. Before this decision, a bundled entry with a later date took over from it.
- An overrides file takes effect at the next start of `serve` or the next `heimdall-hub prices update`.
- The Hub makes an outbound HTTPS request when `serve` starts, about once a day while it runs, and whenever the command runs. Like the upstream checks, the request carries no credentials.
- This decision supersedes ADR-0014's compiled price table and its rejection of fetching prices at runtime. ADR-0014's other decisions stand.
