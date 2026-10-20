---
type: adr
title: ADR-0020 - The Hub delivers alerts through ntfy, sending what is true now
description: "The Hub pushes Conditions at the alert level, and nothing else, to one ntfy topic: one push when a Condition reaches alert and a quiet recovered message once it has stayed below alert for 10 minutes. Delivery reconciles stored Condition state with a delivery record, so held delivery sends what is true now. Silences hold delivery for one System for a time window and never hide a Condition."
status: accepted
created: 2026-10-20
modified: 2026-10-20
---

# The Hub delivers alerts through ntfy, sending what is true now

## Context

[ADR-0017](0017-the-hub-sets-condition-levels.md) gives every Condition a level the Hub sets, where alert means act now.
An alert reaches the operator today only when they open the dashboard.
That ADR rules out muting, acknowledging, or snoozing Conditions, and reserves silencing for delivery.

Delivery pays off only if a push from Heimdall is rare and right, so the operator acts on it instead of silencing the app.
Three facts bound the noise.
Only System stale, Service down, job failing, Reports rejected, disk at its alert limit, and clock skew at its alert limit reach alert; load, hot-process, and update Conditions stop at warning.
The Hub already waits before raising Service down and System stale, and steps disk down with hysteresis.
Open Conditions are stored in PostgreSQL and survive a Hub restart, and the Hub evaluates them on a timer whether or not Reports arrive.

The Hub has made no outbound requests until now.

## Decision

**Only alerts interrupt.**
The Hub pushes a Condition when it is raised at alert or steps up to alert.
Notes and warnings are never pushed.
A Condition that alerts when it should not is fixed by its limits in Hub configuration, never by a delivery filter.

**A delivery covers one Condition identity's time at alert.**
A delivery opens when a Condition of an identity (System, kind, and subject) reaches alert, and sends one high-priority push.
It stays open while that identity keeps returning to alert, across level changes and across occurrences, and sends nothing more.
It closes once the identity has stayed below alert for 10 minutes, whether cleared or open at a lower level, with one low-priority recovered message.
That message states where the identity stands now, cleared or at its current level, and how many times it reached alert during the delivery.
A restart loop reads as one delivery, and a recovered message is never sent while the problem is still recurring.
Reaching alert again after a delivery closed opens a new one.

**Delivery sends what is true now.**
The Hub delivers on its own loop by comparing stored Condition state with a stored record of its deliveries.
It never hooks the code that raises Conditions, which runs on every evaluation.
Delivery can be held by a silence, an unreachable channel, or the Hub being offline.
When it resumes, a delivery that would have opened and closed in the meantime sends nothing, and one still open sends its push with how long the Condition has been at alert.
A delivery already pushed before the hold sends nothing more until its recovered message, which goes out when the hold ends if the delivery closed during it.
The Timeline keeps the full history either way.
Messages that come due in the same pass are sent as one, which links to the fleet's page instead of a single Condition's.
When the delivery record is empty, as when delivery is first configured, the first pass sends one message for the Conditions already open at alert; occurrences recorded closed, such as backfilled history, never send.

**A silence holds delivery for one System for a time window.**
The Hub's command line starts and ends silences and stores them in the database; they are runtime state, like Pairing tokens ([ADR-0009](0009-collectors-pair-with-the-hub.md)), not settings, so a maintenance window needs no restart.
A silence never hides a Condition or changes a System's health, and there is no silence by kind or by Condition.
The dashboard shows active silences and stays read-only ([ADR-0015](0015-dashboard-is-its-own-app-reading-the-hubs-database.md)).

**The channel is one ntfy topic.**
Hub configuration names the ntfy server, the topic, an optional access token, and the dashboard's address for links, so a free topic whose name is its secret, a reserved topic with a token, or a self-hosted server all work.
Pushes go out at high priority and recovered messages at low, each linking to the Condition's dashboard page.
Without that configuration, delivery is off.

**A failing channel shows on the dashboard.**
When every send has failed for 10 minutes, the Hub raises a delivery failing Condition at warning, since the broken channel cannot report itself, and clears it on the next successful send.
Which System's identity it carries is settled when it is built, since the Hub does not know its own System.

This ADR does not cover the Hub's own System going down, when nothing can be delivered, or outages too short to raise a Condition.

## Consequences

- The Hub makes outbound requests for the first time, to the ntfy server only.
- On a public ntfy server, System, Service, and job names and the Hub's reasons leave the fleet. A self-hosted server keeps them in; a reserved topic with a token keeps them private.
- The topic, when it is the only secret, and the token stay out of logs.

## Considered options

- **Deliver through the operator's agent gateway.** Rejected: an agent on another System in the delivery path adds two ways for an alert to fail.
- **Pushover.** Rejected: it is a paid, closed service, and ntfy's priorities already cover the levels.
- **A chat webhook.** Rejected: alerts would share a channel with conversation, under coarse notification controls.
- **Email.** Rejected: too slow and too easy to ignore for act now.
- **Push warnings too.** Rejected: a warning asks for action this week, which does not justify an interruption.
- **Suppress a repeat push for 30 minutes after an alert.** Rejected: a recovered message between repeats would report a restart loop as fixed.
- **Notify from the code that raises Conditions.** Rejected: it runs on every evaluation and after every restart, so it would resend or drop messages.
- **Silences in Hub configuration.** Rejected: a maintenance window is temporary, and changing configuration restarts the Hub.
- **A pluggable channel layer.** Rejected until a second channel has a user.
