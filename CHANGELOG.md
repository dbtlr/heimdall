---
description: "Released Heimdall changes, compiled from changelog fragments at each release cut."
---

# Changelog

Notable changes to the Collector and the Hub, in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Heimdall is pre-1.0, so a minor release can break compatibility.

This file holds released sections only. Pending entries live in [`.changes/`](.changes/README.md) until a release cut compiles them ([Releasing](docs/releasing.md)).

## v0.10.0 - 2026-10-28

### Added

- **Services can name their Application, and Docker checks report their image** (HMD-176). A Service record can name an Application on the same System, recorded in either order. The Collector reads each Docker Service's image reference from its existing inspect request and reports image changes; the Hub mirrors it and the records read API returns it. Upgrade the Hub, then its Collectors, before a provisioner records `application`: an older Collector refuses a record with the field.
- **Services tab** (HMD-174). Every recorded Service on a paired System, plus forgotten Services with an open Service Condition, appears in one list, with down, restarted, up, or unknown status. Status and System filters stay in the URL, and a navigation badge counts Services that are down or restarted.
- **Services show their installed version** (HMD-177). The Hub derives each Service's installed version and upstream: a Docker Service's image tag, or the version and `source` of the Application it names, with a fresh APT or Homebrew census superseding the recorded version. It keeps each change from this release on. The Services table gains a Version column, and a Service page shows what is installed, or why its version is unknown.
- **The Hub checks upstreams for newer releases** (HMD-178). Every six hours, the Hub asks each GitHub, npm, and OCI upstream that a Service runs from for its releases, over HTTPS and without credentials, and keeps the newest release on each channel, when it first found each one, and when its last check succeeded or why it failed. A rate-limited check waits for the reset time the upstream gives. The dashboard shows available updates in a later release.
- **Services show available updates** (HMD-179). The Services list shows newer releases beside installed versions, with an Updates filter. Each Service page shows its available update, when it was first found, and any upstream check failure. APT and Homebrew updates name the check that found them. Update rows stay in the history after an upgrade or a release is withdrawn. Available updates do not change Service status or raise Conditions.
- **Fleet Timeline filters** (HMD-189). The Timeline filters by level, System, and open or cleared at every width, using the same Filter sheet and removable pills as the Services page. The selections live in the URL, so bookmarks and history keep them.

### Changed

- **Service restarted notes move to Services** (HMD-174). On paired Systems, they leave System Open Conditions and Fleet Can wait. Service pages link back to Services and keep a link to their System.
- **Wide-screen sidebar** (HMD-185). From 1024 px up, a left sidebar holds the navigation and every System with its status, worst problem, and CPU, memory, and disk meters, and all pages share one wider content frame. Narrower screens keep the tab bar and header links.
- **Service page history** (HMD-175). Under the 90-day strip, a Service page lists its Service stops and its Service down raises and clears in one history, newest first, each row led by its date and time. The newest 6 show and Show older opens the rest; a Service down row opens its Condition.
- **Fleet lanes on wide screens** (HMD-186). From 1024 px up, the Fleet page shows each System as a lane on one time axis, with the range picker and Open now, as Compare does. Narrower screens keep the tiles and read none of the lane data.
- **Wide-screen Fleet Timeline** (HMD-188). From 1024 px up, the Timeline page is a table with one row per occurrence, grouped under Today, Yesterday, and dated day headings, showing each occurrence's transitions and how long it was or has been open. Narrower screens keep the cards.
- **Wide-screen Service page** (HMD-190). From 1024 px up, a Service's checks, record, installed version, and update sit in a panel on the right, level with the top of the page, beside the stops strip and history. Narrower screens keep the lines under the title.
- **Wide-screen Now tab** (HMD-187). From 1024 px up, a System's Now tab shows four cards for CPU busy, memory, disk, and load, with CPU and memory lines over the loaded range, and lists each open Condition as one table-like row that still opens to its evidence and next step. Narrower screens keep the Vitals glance and the stacked Conditions.
- **Command lines run on Loom 0.16** (HMD-198). On SIGTERM or SIGINT, `serve` and `run` get up to 10 seconds to finish their running work and close their databases, then the process ends by the signal, where it used to exit with 143 or 130; systemd still counts it as a clean stop. Every binary finds its home as Loom does, from an absolute `HOME`, else the account's home, for its log and configuration alike. A closed stdout pipe now ends a command silently with exit code 141.

## v0.9.0 - 2026-10-24

### Added

- **Purge a retired System from the Hub** (HMD-137). `heimdall-hub purge system <system>` deletes everything the Hub holds for an unpaired System, which removes the System from the dashboard and from the records read. Its transcripts and their Session insight stay unless given `--transcripts` ([Purging a retired System](docs/spec.md#purging-a-retired-system)).
- **Purge a forgotten Service from the Hub** (HMD-138). `heimdall-hub purge service <system> <service>` deletes the Service down Conditions, Timeline, and deliveries the Hub holds for a Service its System no longer records, which removes the Service from the System's history ([Purging a forgotten Service](docs/spec.md#purging-a-forgotten-service)).
- **The Collector logs systemd Service stops** (HMD-164). At each Service check the Collector compares what systemd holds about a unit with a baseline it keeps per Service and per boot. It logs each stop, even one shorter than a check, with when it stopped and ran again and its restarts, and with how it ended when a check saw it stopped. The log rides Reports in a new `serviceStops` section until the Hub takes it; upgrade the Hub before its Collectors, and run systemd 247 or later ([Service stops](docs/spec.md#service-stops)).
- **The Hub keeps Service stops and raises a Service restarted note** (HMD-165). The note shows the latest run's stop count, first and last stop, and latest result in Can wait, and clears 24 hours after the latest stop began. It never escalates or sends a push. Ended stops stay for 90 days; System and Service purges remove them and their Conditions ([Service stops](docs/spec.md#service-stops)).
- **A page for each Service's stops** (HMD-166). A Service's name in a System page's Recorded panel opens `/systems/<System>/services/<Service>`, which shows its stops from the last 90 days on a strip and in a list by day, with how each ended, how long the Service was down, and when the Hub received it. The dashboard also answers `GET /api/v1/service-stops`, which reads the same stops back, filtered by `system`, `service`, and `since`, and by `unpaired=include` for Systems no longer paired ([Service stops](docs/spec.md#service-stops)).
- **The Collector logs Docker container stops** (HMD-167). At each check of a `docker` Service the Collector compares when the container last started and finished, its restart count, and how its last run ended with the baseline it keeps, and logs each stop as it does for systemd. A recreated container, as after a deploy, counts as a stop from its creation to its start. Container stops reach the Hub's Service restarted note and the Service page unchanged ([Service stops](docs/spec.md#service-stops)).
- **The Collector logs launchd Service stops** (HMD-168). At each check of a `launchd` Service the Collector compares launchd's run count, the pid of the running process, and how its last run ended with the baseline it keeps, and logs each stop it finds, timed to the minute between the two checks around it, since launchd holds no times. On macOS the Collector now reads the boot from `sysctl`, so Docker Desktop container stops are logged there too. Both reach the Hub's Service restarted note and the Service page unchanged ([Service stops](docs/spec.md#service-stops)).

### Changed

- **The Fleet page opens on System tiles** (HMD-160). Each System is a tile with its health, how long ago it was last seen, and CPU, memory, and disk meters. Asleep Systems show a moon and silenced ones a crossed-out bell with the time left; the fleet verdict moves into the header, and notes gather in a "Can wait" list under the tiles.

## v0.8.0 - 2026-10-21

### Added

- **Alerts reach a phone through ntfy** (HMD-149). With a `[delivery]` section in
  `hub.toml`, the Hub pushes each Condition that reaches alert to one ntfy topic,
  once, and sends a quiet recovered message after it has stayed below alert for
  10 minutes, counting how often it returned. A Condition that was raised and
  cleared while ntfy or the Hub was down sends nothing.
- **The Fleet page says when alert delivery is failing, and `heimdall-hub delivery test`
  checks the channel** (HMD-150). When sends to ntfy have been failing for 10 minutes,
  the Fleet page shows "Alert delivery failing since" and the time, in the warning
  color, until a send succeeds. The line is a status of the Hub, not a Condition, so the
  verdict and counts do not change. `heimdall-hub delivery test` sends one low-priority
  message through the `[delivery]` channel and reports whether ntfy took it, without
  printing the topic or the token. A test message that gets through also clears the
  failing status. Migration 35 adds the `delivery_status` table.
- **Silence alert delivery for one System** (HMD-151). `heimdall-hub silence <system> --for 2h`
  holds ntfy pushes and recovered messages for that System until the time is up;
  `--clear` ends it, and `heimdall-hub silence` with no System lists the active ones. The dashboard
  still shows every Condition. When the silence ends, a Condition still at alert
  sends its push with how long it has been there, and one that was raised and
  cleared during the silence sends nothing.
- **The dashboard shows a System's active silence** (HMD-152). A silenced System's
  Fleet card and System page say "Alerts silenced until" the time and how long is left.
  The silence changes no health, count, or Condition shown.

### Changed

- **Phone tab bar stands apart from the page** (HMD-156). The bottom bar is
  raised above the page with an icon over each label, and the current tab turns
  the primary color. Each tab fills a third of the bar, and the labels sit above
  the iOS home indicator.

### Fixed

- **Mobile header stays clear of the status area** (HMD-155). A solid raised
  header and safe-area spacing keep titles readable. A fixed opaque strip provides
  Safari a persistent background to sample while scrolling.
- **A Hub outage no longer marks every System stale** (HMD-159). After the Hub or
  its database was down for more than 2 minutes, the Hub waits 10 minutes before it
  raises stale System, so the Collectors can deliver what they queued and no alert
  is pushed for the Hub's own downtime. A stale System that was already open stays
  open through the outage.

## v0.7.2 - 2026-10-18

### Added

- **Sessions in every worktree of a git repository share one project** (HMD-142). A Session that ran in a linked worktree, such as `.../worktrees/heimdall/fix-login`, is now filed under its repository, `heimdall`, instead of the worktree's folder name. The Collector reads which repository each Harness process's working directory belongs to, from git's pointer files only, and reports it; the Hub gives a Session the repository of the most recently started Harness process on its System, seen in the same working directory, that reported one, and `insight.sessions` gains a `repository` column. Upgrade the Hub first, then every Collector: a Hub older than this drops the `repository` a newer Collector sends, and a process that ends before the Hub is upgraded never gets it. Sessions with no matching Harness process, including all Sessions from before the upgrade, keep their folder-name project.
- **Agents breaks the period's list-price cost down by project, System, model, or Harness** (HMD-143). A switch on the cost card chooses the split and keeps it in the address, and a stacked bar and a ranked list show each row's share and cost. A row with unpriced requests reads "At least"; a row with none priced reads "No list price". Tapping a row filters the Sessions list to that project, System, model, or Harness, and tapping it again clears the filter. The Hub now stores each Session's totals by model, so upgrade the Hub before the dashboard.
- **The Hub raises a Clock skew Condition when a System's clock disagrees with the Hub's** (HMD-139). It compares each Report's sent time with the moment the Hub received the request, and grades the gap in either direction: a note at 30 seconds, a warning at 120, and an alert at 300, well before a skew hides a System's newest samples from the disk, load, and hot-process judgments. When several Systems are off by the same amount and one reads true, the Hub blames its own clock and raises the Condition on that one System. Limits are configurable under `[conditions.clock]`, with per-System overrides. Upgrade the Hub before the dashboard.
- **On a phone, a picked Agents breakdown row says how many Sessions it matched and links down to them** (HMD-144). Below the wide layout the Sessions list sits under the cost card, out of sight, so the picked row now shows its Session count and a "Show them" link to the filtered list. The wide layout, with the list beside the card, is unchanged.

### Changed

- **macOS high memory is judged by the kernel's memory pressure alone** (HMD-122). A macOS sample counts as busy when pressure is `warning` or `critical`, at any use. Live readings showed pressure rising at 70 to 80% used, below the 90% limit the old rule also required, so the Condition could never be raised on macOS. `[conditions.memory].percent` now applies to Linux only. A macOS sample without pressure, as from a Collector older than 0.7.0, is unknown evidence. The Condition page states the pressure rule for a macOS System and draws no usage line. CPU and Linux memory defaults are unchanged; 12 days of live readings supported them.

## v0.7.1 - 2026-10-17

### Added

- **Hub stores the Condition limits it judges by** (HMD-127). On start, the Hub writes the fleet's limits and each System's overridden limits to its database, so the dashboard can draw them without reading `hub.toml`.
- **Each Condition opens its own page** (HMD-114). The page leads with the culprit's number, charts disk, CPU, memory, and hot-process readings against the System's limits, estimates when a filling disk would be full, and lists the level history and the next step. Fleet cards, the Now tab, Open now, and the Timeline link to it. Upgrade the Hub first so it stores the limits the page draws.

### Changed

- **Pending updates raise one Condition for each package source** (HMD-128). A System with several pending Homebrew or APT packages now shows one Pending update Condition per package source, instead of one per package. The Condition is a warning once a security update in the source has waited longer than the limit, and a note otherwise. Its page lists the packages with their versions and security status, and says how to install them. On upgrade the Hub merges open per-package Conditions into one for each source, keeping the earliest raise time. Upgrade the Hub first.

## v0.7.0 - 2026-10-16

### Added

- **Hub-owned Condition levels and history** (HMD-109). Every Condition carries note, warning, or alert. Disk levels start at 70%, 80%, and 90% used, with configurable recovery margins and per-System overrides in `hub.toml`. Level changes keep the same Condition and appear in its Timeline. Existing history is preserved with explicitly backfilled levels.
- **The Agents view shows list-price cost across the fleet** (HMD-112). Today, 7-day, and 30-day periods count only requests made within that period, including subagents, with a Claude Code and Codex split and Sessions ordered by cost. Unpriced requests label amounts "At least"; recent requests mark a Session "Active recently". Each Session opens its existing detail page.
- **Phone navigation and fleet Timeline** (HMD-111). A bottom bar links to Fleet, Agents, and Timeline on narrow screens. The fleet Timeline keeps raised, level-changed, and cleared transitions together by Condition occurrence, including labelled unpaired history.
- **Sustained and recurring CPU and memory Conditions** (HMD-115). CPU above 90% for 30 minutes within an hour raises a note, and two hours within four hours raises a warning. Memory above 90% for 30 minutes within an hour raises a warning, with macOS memory pressure required to exclude full cache. Fleet and per-System limits live in `hub.toml`. Quiet readings can preserve a recurring pattern, missing evidence never establishes recovery, and delayed Reports retain completed episodes in the Timeline.
- **Hot-process Conditions name the executable and PID** (HMD-116). One process above half a CPU core for 30 measured minutes within an hour raises a note, and two hours within four hours raises a warning. The Collector reports its five hottest processes without arguments or environment variables. Missing evidence preserves the stored level, confirmed exit clears immediately, and delayed Reports retain completed episodes in the Timeline. Fleet and per-System limits live in `hub.toml`.
- **Pending-update and reboot-required Conditions** (HMD-118). The Collector checks existing local package metadata on a configurable six-hour schedule and reports coverage and observation times. Pending updates raise notes; confirmed security updates become warnings after three days, and a required reboot after seven days. Stale or unavailable evidence preserves open Conditions. Homebrew requires the owning account and supported local metadata; macOS Software Update coverage remains unavailable. Hub age limits support fleet defaults and per-System overrides.

### Changed

- The dashboard reads stored Hub levels for Condition marks and System health. Notes remain visible without making a System unhealthy, and old evidence does not lower an open Condition's level.
- **System navigation fits a phone** (HMD-110). System pages have a sticky Fleet back link, status pills to switch Systems, and Now, Vitals, Sessions, Records, and Timeline tabs. Now leads with Conditions and a compact Vitals glance. Long lists collapse, and tapping a chart opens a sample sheet on phones. Tabs and ranges share through the URL, including older sample links.
- Fleet shows compact System summaries and links to Compare, which preserves the shared-axis lanes, range controls, and optional unpaired lanes.
- **Fleet opens with what needs attention** (HMD-113). A verdict identifies the worst open Hub level and the number of Systems at that level, followed by alert and warning cards with their culprit, evidence, and next step. Notes collapse separately. Compact System cards show counts by level, dated CPU, memory, and disk readings, and CPU history on a stated 0–100% scale. Sleeping Systems stay dimmed while their open Conditions keep contributing to the verdict.
- **Hub skips unchanged CPU and memory load windows** (HMD-121). Idle evaluations check the latest eligible sample without replaying the raw window. Changed limits, late samples, and re-pairing still trigger rejudgment.

### Fixed

- **Compare dates Vitals by their sample time** (HMD-120). CPU and memory readings carry the System's sample timestamp independently of Last seen, including on unpaired Systems.
- **Hub rejudges cached hot-process evidence** (HMD-125). A busy process judged while its evidence was old now raises its Condition once a clock correction makes the same evidence fresh. Re-pairing a System rejudges its processes without waiting for a new sample.

## v0.6.4 - 2026-10-15

### Fixed

- **The dashboard's favicon is served as files for mobile Safari** (HMD-105). Safari on iPhone showed no icon for the SVG inlined in the page. The icon is now served at `/favicon.ico`, `/favicon.svg`, and `/apple-touch-icon.png`, the last for iPhone tabs, Favorites, and the home screen.

## v0.6.3 - 2026-10-14

### Added

- **The dashboard has a favicon** (HMD-102). Browser tabs show Heimdall's H standing on a blue heartbeat trace instead of a blank icon.

### Changed

- **The dashboard shows every time in the viewer's own timezone** (HMD-103). Clock times, weekdays, and the day marks on the time axes follow the browser's zone instead of the machine the dashboard runs on.
- **The dashboard says why a System needs you** (HMD-98). A lane's status names the Condition and its subject, such as Drift on a file or Service down on a unit, and opens it on System detail. Open now becomes a table of what was observed, when it was first detected, and when its latest check arrived. System detail opens with each open Condition's expected and observed state and a next step with the commands to run. Evidence that cannot confirm a failure shows apart and greyed: a check set or run set older than 2 hours, a check that could not tell, a recorded file the Collector could not read, and checks that stopped arriving while the System still reports.

## v0.6.2 - 2026-10-14

### Changed

- **The Hub stores Session stretches and totals, so dashboard pages load in under half a second** (HMD-97). The Hub keeps each Session's stretches and totals, cost included, and refreshes a Session within about 15 seconds of anything they are computed from changing. A price change reprices every Session within a few refreshes. `insight.session_stretches` and `insight.session_totals` read the stored rows and keep their columns. On a copy of the live archive, after HMD-96, the 24-hour overview drops from 6 seconds to 0.1, and the 7-day overview from 13 to 0.4. A parser switch lags longer, while the refresh works through every Session it changed. The first start after upgrading stores every Session over a minute or two; until a Session is stored, its stretches and cost are missing from the views and the dashboard. See [ADR-0016](docs/decisions/0016-session-stretches-and-totals-are-stored-and-refreshed.md).

### Fixed

- **Dashboard pages read each Session's cost once** (HMD-96). The fleet overview and System detail looked up a Session's totals once per stretch, re-pricing every request of the Session each time. They now look each Session up once, through one shared stretches read. On the live archive the 24-hour overview drops from about 22 to 7 seconds and the 7-day overview from 31 to 12.
- **The Hub's refresh of stored Session insight drains a backlog without slowing down as it grows** (HMD-99). It picks up to 20 stale Sessions at a time and leaves out only those that failed or another refresh holds, instead of sorting every stale Session again for each one. A backlog of 2,400 Sessions, such as every Session after a price change, drains in 3 seconds instead of 19.

## v0.6.1 - 2026-10-13

### Fixed

- **Slow dashboard pages keep their HTTP connection** (HMD-95). The dashboard waits 60 seconds before closing an idle connection, allowing its 30-second database statement limit to finish or report an error. The Hub keeps its existing timeout. A delayed page is tested through the real HTTP listener.

## v0.6.0 - 2026-10-13

### Added

- **The dashboard ships in each release and runs as its own Service** (HMD-83). `heimdall-dashboard` installs through `install-dashboard.sh` like the Collector and the Hub, and `heimdall-dashboard service install` runs it as a user Service on the Hub's System. It reads the Hub's database URL from `hub.toml`, takes its `host` and `port` from `~/.config/heimdall/dashboard.toml` (port 3000 by default), and answers `GET /api/health` in the Hub's shape. [Running Heimdall with Fleet](docs/fleet.md) shows how a provisioner declares it.
- **Fleet overview** (HMD-81). The dashboard's front page shows every System as a lane on one time axis over 6 h, 12 h, 24 h, or 7 d: CPU low and high, agent Sessions by Harness and how they were linked, Conditions raised and cleared, gaps while a System was silent, each System's status in words, and the Conditions open now.
- **System detail** (HMD-82). Each System's page stacks its Vitals, its Harness processes, and its Sessions on one axis, inspects any single sample, and lists what its provisioner recorded beside its 7-day Timeline.
- **Session page** (HMD-88). Each Session row on a System's page opens the Session at `/systems/<name>/sessions/<harness>/<source>/<session id>`, under a header with its place, span, and totals, in three tabs that link to each other.
  - **Timeline:** a lane per agent, with request marks by model, over the System's CPU, its Harness processes' cores, and the process link, and an inspector for any request.
  - **Cost:** what the list-price cost paid for by token kind, how it ran up for the main conversation and subagents, and the main conversation's context fill, then the cost by agent, model, skill, and tool.
  - **Trace:** every main-conversation request with its tool calls, with subagents folded, waits, skills, commands, and process links between them.
- **Cost by token kind in `insight.requests`** (HMD-88). `input_cost_usd`, `output_cost_usd`, `cache_read_cost_usd`, and `cache_write_cost_usd` split each priced request's `cost_usd` by the tokens it paid for, as described in [the spec](docs/spec.md#cost).
- **The dashboard shows what the Hub's page shows** (HMD-91). The Fleet overview ends with "Show N unpaired Systems", which adds the unpaired Systems below the paired lanes, greyed and marked Unpaired, with their open Conditions in Open now tagged "unpaired". The choice lives in the URL as `?unpaired`. An unpaired System's page opens under a banner that says its history is kept and no new Reports arrive. With no paired System the overview says "No System is paired."; when paired Systems have yet to report, it keeps their Never seen lanes under "No System has reported yet."
- **A facts card on each System's page** (HMD-91). Beside the platform, the header line now gives the Collector's version, and a card above the plots gives the load averages, the use of each disk with a bar that turns orange below 10% free, where the low disk Condition is raised (it clears only above 15%), and each installed Harness with where it was found, or "None installed" when the Collector looked and found none.
- **The dashboard refreshes itself** (HMD-91). Every page but the Session page reads its data again every 15 seconds while its tab is visible, and at once when the tab comes back.

### Changed

- **The dashboard serves `GET /api/v1/records`, and the Hub no longer does** (HMD-86). The answer is unchanged, `?unpaired=include` and its 400s included, but it is served at the dashboard's address, and the Hub answers 404. A provisioner that reads the records points at the dashboard when it upgrades the Hub; Fleet's doctor takes the address with `--hub`. See [Reading the records back](docs/spec.md#reading-the-records-back).
- **The Hub no longer serves a page** (HMD-92). `GET /` and `/?unpaired` on the Hub answer 404; the dashboard shows everything the page showed. Point the Hub's public web name at the dashboard (Fleet ask A13 in `docs/fleet.md`). Upgrade only once the dashboard is declared (A11) and the web name points at it (A13); until then the web name answers 404.

### Fixed

- **`service status` on macOS notes a missing GUI login session** (HMD-87). launchctl answers 112, not 113, for a GUI domain that does not exist, so the "no GUI login session" note never appeared on a real Mac. The launchd tests now run against output captured from macOS.
- **`heimdall-hub serve` on a port in use says which address it could not listen on** (HMD-89). It logs `Could not listen on <host>:<port>: <cause>` as a fatal line and exits 1, as the dashboard does, where a release build showed only "Something went wrong." while systemd restarted the unit.
- **The dashboard's API routes answer 405 to any method but GET and HEAD** (HMD-86). `POST /api/health` and the like rendered the dashboard's page with 200.

## v0.5.0 - 2026-10-12

### Added

- **Collector reports which Harnesses are installed and their versions** (HMD-40). The Collector reads install directories and package metadata to find Claude Code and Codex, and never runs either. The Hub shows the latest list for each System in a Harnesses column; upgrade the Hub, which applies migration 13, before the Collectors. [The spec](docs/spec.md#installed-harnesses) lists where each version is read.
- **Collector reports Harness processes** (HMD-69). On Linux and macOS the Collector records each Claude Code and Codex root process every 15 seconds in a new `harnessProcesses` Report section: its pid, start, end, working directory, and the CPU time and memory of its process tree, never its command-line arguments or environment. The Hub keeps the processes, closes one the Collector stopped listing as an end it missed, and stores each reading as a sample that rolls up and prunes like Vitals; upgrade the Hub, which applies migration 14, before the Collectors.
- **The Hub derives Claude Code Session insight from the transcripts it holds** (HMD-65). `heimdall-hub serve` parses new transcript content every 15 seconds into Sessions, subagents, requests, and tool calls, counting each response once. A parser version change rebuilds beside the old facts, which stay readable until the rebuild catches up. A Hub that already holds transcripts projects them at up to 64 MiB a run while it serves, so the views fill over about 25 minutes for a 5 GB archive. See [Session insight](docs/spec.md#session-insight).
- **The `insight` views** in the Hub's database read Session insight: Sessions, subagents, requests, tool calls, totals with and without subagents, and parse status. They carry facts and locators into the archive, never transcript content. See [The insight views](docs/spec.md#the-insight-views).
- **The `insight` views price each request at API list prices** (HMD-67). `insight.requests` gains `cost_usd`, `context_window`, and `context_fill_percent`, and the totals views gain `cost_usd`, `priced_cost_usd`, and `unpriced_requests`. A request is priced from a dated table the Hub bundles for current Claude and OpenAI models, by the entry in force at the request's time, so a price change never reprices earlier requests. Models that reprice the whole request above a prompt size, such as Claude Haiku 5.5 and gpt-6.x, are priced by the request's own prompt size. A request whose model has no price is unpriced (null), never free, and a total that includes one says so. Cost is computed when read and never stored. See [Cost](docs/spec.md#cost).
- **Price overrides in the Hub's configuration.** `[prices] overrides`, `--price-overrides`, or `HEIMDALL_PRICE_OVERRIDES` names a JSON file of entries dated like the bundled ones, which add models or replace a bundled price from a date. A relative path resolves from the working directory. See [Cost](docs/spec.md#cost).
- **A read-only role can query the insight views** (HMD-68). Name a role the provisioner created in `[database] insight_reader`, and `serve` lets it read the `insight` views and nothing else: no transcript, token, Pairing code, or other table, and no writes. Every view is now a security barrier, so the role's own filters never surface a row a view hides. A role that does not exist yet is granted within a minute of being created; the Hub's own role, a superuser, a member of the Hub's role, or a member of `pg_read_all_data` is refused. When the Hub's role owns its database, `serve` also stops other roles creating temporary tables there. See [Querying the insight views](docs/insight-reader.md).
- **`heimdall-hub transcripts show` prints raw transcript lines on the Hub's System** (HMD-68). It prints a Session's main conversation or one of its subagents, every line of a request with `--request`, a whole generation, or the line at a locator from `insight.requests` or `insight.tool_calls`. See [Upload protocol](docs/spec.md#upload-protocol).
- **The Hub derives Codex Session insight from the transcripts it holds** (HMD-66). `heimdall-hub serve` projects Sessions, nested subagents, requests, and completed tool items into the same `insight` views as Claude Code. Each response counts once, fork replay is excluded, requests retain their turn's model and context window, which `insight.requests` reads before the price table's, and inferred skills have separate tool rows marked as inferred. Unknown turn models remain counted as `unknown` and unpriced. Invalid headers and legacy forks without a replay cutoff are marked unreadable and yield no facts. Session totals include subagents without counting inherited usage again. A Codex parser version change rebuilds Codex facts while Claude Code facts stay readable. See [Codex Session insight](docs/spec.md#codex).
- **The Hub links each stretch of a Session to the Harness process that ran it, when only one process the Collector saw could have** (HMD-70). `insight.session_stretches` and `insight.request_links` mark each stretch of a Session, and each request, linked, ambiguous, or unmatched by System, Harness, working directory, time, and whether the Collector read the process during it. A process the Collector never saw can still have made some of a linked stretch's requests, a limit the spec lists. A Session resumed in a new process links to each process for its own stretch. `insight.vitals`, `insight.vitals_processes`, `insight.vitals_sessions`, and `insight.vitals_requests` show, for any Vitals sample, the processes running then with their CPU and memory, the Sessions each was running, and the requests answered in the sample's interval. See [Linking Harness processes to Sessions](docs/spec.md#linking-harness-processes-to-sessions).

### Fixed

- **The Hub waits for a lock a backup holds instead of crash-looping** (HMD-63). A migration that needs a lock another session holds, such as a stalled `pg_dump` on `systems`, now fails after 5 seconds with a lock error, not after the 30-second statement timeout. `heimdall-hub serve`, `pair`, `unpair`, and `transcripts delete` roll back, log the holding session's pid and application name at most once a minute, with its state and start time when the Hub's role can see them (a role with `pg_read_all_stats`, such as `pg_monitor`, can), and retry with a backoff of 1 to 30 seconds, so `serve` stays up and listens once the migrations apply. A migration error that is not a lock wait still exits 1.

## v0.4.0 - 2026-10-10

### Added

- **`heimdall-collector record` and `forget`** (HMD-53). A provisioner pipes a JSON record of an Application, Service, job, or set of files to `heimdall-collector record <kind>`, and a job's run to `record run <job>`. The Collector validates each, refuses fields it does not know, and keeps them in its state directory; `forget <kind> <name>` removes one.
- **Run history pruning.** The Collector keeps each job's runs for 90 days, and always keeps the latest successful run.
- **The Hub mirrors each System's records** (HMD-54). Collectors send their whole record set in Reports when they start, when a `record` or `forget` changes it, and hourly. The Hub keeps each System's latest set, so a forgotten record leaves the mirror.
- **`GET /api/v1/records`** returns every System's mirrored records as JSON, with the same trust as the dashboard, so a provisioner can compare them with what it declares. See [Reading the records back](docs/spec.md#reading-the-records-back).
- **The Hub shows each job's latest run and latest success** (HMD-37). Collectors send them in Reports when they start, when a `record run` or `forget` changes them, and hourly, without resending the record set. `GET /api/v1/records` returns them for each System beside its records.
- **The Hub knows each System's time zone**, since jobs' schedules are in local time. Every Report names the zone `/etc/localtime` names, read afresh so a change of zone shows at once. `GET /api/v1/records` returns it.
- **The Hub raises job failing and job overdue Conditions** (HMD-39). A job whose latest run failed is failing. A job is overdue when its System was awake for its grace period after a scheduled time with no successful run since, so a laptop asleep through a scheduled time is not overdue until it has been awake that long. The page and the Timeline name the job. See [Job Conditions](docs/spec.md#job-conditions).
- **A job record may set `graceMinutes`**, from 1 to 10,080, the awake time the Hub waits after a scheduled time before it raises job overdue. It is 60 when left out. Upgrade the Hub, then the Collectors, before a provisioner sends it.
- **The Hub raises stale System and low disk Conditions** (HMD-55). A System the Hub has not heard from, by Report or transcript upload, for more than 10 minutes, or 7 days when it sleeps, is stale; a paired System that never reported counts from its pairing and shows as never seen. A mount below 10% free in a System's latest Vitals sample is low on disk, until it is above 15% free again. A System that is unpaired has both cleared. The page and the Timeline name the mount. See [System Conditions](docs/spec.md#system-conditions).
- **A Collector's `collector.toml` may set `sleeps = true`**, which every Report then carries, for a System such as a laptop that sleeps. It is `false` when left out. Upgrade the Hub, then the Collectors; until a Collector sends `sleeps`, the Hub treats its System as always on.
- **The Hub raises Drift for recorded files that changed or went missing** (HMD-35). The Collector hashes every file in its `files` records when it starts, right after a record changes, and hourly, following symbolic links, and reports those that do not match in a new `checks` section of the Report. The Hub raises one Drift Condition for each path, whose reason says whether the file changed or is missing, and clears it when the file matches again, or when its record is forgotten and no other `files` record is unreadable. A file the Collector cannot read, such as a directory or a file it lacks permission for, raises nothing and leaves an open Drift as it is. See [Drift](docs/spec.md#drift).
- **`GET /api/v1/records` returns each System's checks**, so a provisioner can see which recorded files were unreadable. A Hub with this change accepts Reports from Collectors without it. Upgrade the Hub, then the Collectors.
- **The Hub raises Service down for systemd and systemd-user Services that stay stopped** (HMD-36). The Collector asks `systemctl` about every recorded `systemd` and `systemd-user` Service each minute and reports each check's state, a short detail, and since when in a new `services` part of the `checks` section; a Service it has no way to check is reported as unchecked, never as down. The Hub raises one Service down Condition per Service once a check has been stopped for 2 minutes of the System's awake time, counted in its Vitals samples, 15 seconds each, so that neither the System's clock nor time spent silent or asleep counts, and clears it when the check passes or the Service is forgotten. A check the Collector could not make, such as when the account has no user bus, leaves the Condition as it is. See [Service down](docs/spec.md#service-down).
- **`GET /api/v1/records` returns each System's Service checks** in `checks.services`. A Hub with this change accepts Reports from Collectors without it, and leaves open Service down Conditions as they are for such a System. Upgrade the Hub, then the Collectors.
- **A systemd or systemd-user `service` record may not name its `unit` as a pattern or a job id**: `record` refuses a unit with `*`, `?`, or `[`, or made only of digits, since `systemctl` would read it as more than one unit or as a job.
- **Each part of the `checks` section has its own budget.** The Collector sends a part over 1 MiB as its size in `overBudget`, named for the part, and the other parts as they are, so a large files part cannot freeze Service down. `GET /api/v1/records` names such a part in `checks.overBudget` and leaves its entries out, and leaves `files` and `fileRecords` out until the Collector has sent a files part, so a provisioner can tell checks not yet made from checks that found nothing.
- **Service down covers launchd Services that stay stopped** (HMD-59). The Collector asks `/bin/launchctl print` about every recorded `launchd` Service each minute, in the `gui/<uid>` domain of the account it runs as and then in the `system` domain. A label with a running process is up. A label that is loaded with no running process, or loaded in neither domain, is stopped, and the Hub raises Service down once it has been stopped for 2 minutes of the System's awake time. A `launchctl` that fails to answer, times out, or is missing leaves the check unknown, so the Condition stays as it is. A `launchd` Service record is for an agent or daemon that is meant to stay running (`KeepAlive`): one that launchd starts on demand or on a schedule is idle by design, reads as stopped, and raises Service down. See [Service down](docs/spec.md#service-down).
- **`record` refuses a launchd `service` record whose `label` contains a `/`**, since `launchctl print` reads the label as part of `<domain>/<label>`.
- **Service check details are cleaned.** The Collector takes control characters out of every Service check's detail and cuts it to 200 characters without splitting a surrogate pair.
- **The Hub raises Service down for a Service whose health URL stops answering** (HMD-61). The Collector requests the `health` URL of each recorded Service every minute, on loopback only, without following redirects and ignoring any proxy setting in its environment, and reports it as a `health` check beside the supervisor check in the `services` part of the `checks` section. A 2xx or 3xx status is up. Any other status, a refused or reset connection, an answer that is not valid HTTP, or no answer in 5 seconds is unhealthy. The Hub raises the Service's one Service down Condition once a check has failed for 2 minutes of the System's awake time, with the reason `Unhealthy: <detail>.` (a stopped supervisor still says `Stopped: <detail>.`), and clears it when every check passes. A health URL that has failed for 2 minutes raises it even while the supervisor check is unknown, since the failure is direct evidence; an unknown check alone still leaves the Condition as it is. A `none` Service with a `health` URL is checked by the URL alone; one without is still listed and unchecked. See [Service down](docs/spec.md#service-down).
- **`GET /api/v1/records` returns health checks** in `checks.services`, with `check` `health` and `state` `unhealthy`. A Hub with this change accepts Reports from Collectors without it, and leaves what it holds unchanged.
- **The Hub raises Service down for docker Services whose container stays stopped** (HMD-60). The Collector asks the Docker Engine API over its unix socket, with no `docker` CLI, whether each recorded `docker` Service's container is running: at `DOCKER_HOST` when that is a `unix://` URL, otherwise at `docker.sock` in `XDG_RUNTIME_DIR` or `/run/user/<uid>`, where rootless Docker under the Collector's account keeps it. A System that runs rootful Docker or Podman sets `DOCKER_HOST` in the Collector's service environment. A running container is up. An exited, created, paused, restarting, dead, or missing container is stopped, and raises Service down after 2 minutes of the System's awake time. An unreachable socket, a timeout, a redirect, or an unexpected answer leaves the Condition as it is, as does a `DOCKER_HOST` that names another transport. Docker's own healthcheck is not read. See [Service down](docs/spec.md#service-down).
- **A docker `service` record's `container` must be a Docker container name or ID**: `record` refuses a `container` that does not start with a letter or digit, holds a character other than letters, digits, `_`, `.`, or `-`, or is longer than 256 characters, since the Collector puts it in the path of an Engine request. Record the name without the leading `/`; a name is better than an ID, which changes when the container is recreated.
- **The dashboard's unpaired view and the records read's `unpaired=include`** (HMD-62). When any System is unpaired, the page links to `/?unpaired`, which lists those Systems with an Unpaired status and their Vitals, last seen, and Timeline. `GET /api/v1/records?unpaired=include` lists them too, and every entry in the read now carries `paired`. See [Reading the records back](docs/spec.md#reading-the-records-back). A provisioner that reads `paired` with the new schema should upgrade the Hub first, since an older Hub sends no `paired`.

### Changed

- **The Hub accepts Reports of up to 12 MiB**, up from 4 MiB, to fit a record set beside a full batch of samples. Upgrade the Hub before its Collectors.
- **The Hub keeps a row for a paired System it has never heard from**, with no last seen, so a Condition can be about it. The page shows it as never seen.
- **The Collector's `mount` and `vm_stat` commands for Vitals now time out after 5 seconds**, as the `systemctl` checks do.
- **`service status` reads a launchd agent as not loaded only when `launchctl print` exits 113 and says it could not find the service, or says the GUI domain is missing**, so any other `print` failure reads as state unknown. It also reads an agent with a pid as running, whatever state launchd names.
- **`heimdall-hub unpair` now hides the System** from the page's normal view and from `GET /api/v1/records`, which a provisioner's checks read as the paired fleet. Its history is kept, and pairing it again brings it back.

### Fixed

- **A System's clock running ahead no longer freezes its transcripts section on the Hub** (HMD-54). The Hub replaces a held section that claims a time later than its own clock, so the next correct Report updates it.
- **`service status` asks the Hub for its health directly**, ignoring any proxy setting in the environment (`HTTP_PROXY`, `http_proxy`), so the request reaches the address the Hub listens on instead of the proxy.

## v0.3.0 - 2026-10-09

### Added

- **The Hub stores agent Session transcripts as Collectors upload them** (HMD-50). The Hub accepts gzipped chunks of each transcript file at the offset it holds, stores them in PostgreSQL, and acknowledges them in the same transaction, as [ADR-0013](docs/decisions/0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md) describes. It keeps each System's latest set of transcript sources from its Reports. `heimdall-hub transcripts delete` removes whole generations by System, source, or last upload before a date, and the Hub refuses a path once every generation there is deleted. Generation ids are random, so a Hub restored from a backup never reissues an id a Collector still holds (HMD-57). `docs/spec.md` describes the upload protocol.
- **The Collector uploads agent Session transcripts to the Hub** (HMD-51). `heimdall-collector run` captures the sources its configuration lists in `[[sessions.sources]]`, Claude Code's `projects/` and Codex's `sessions/`, including the history already there, and captures nothing when none is listed. Every 60 seconds it spools what each file gained into `spool.sqlite` in its state directory and uploads the spool as gzipped chunks the Hub acknowledges, starting a new generation when a file shrinks, is replaced, or no longer matches what was uploaded, as [ADR-0013](docs/decisions/0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md) describes. Every Report carries the sources and the spool's size and age; `service status` shows the spool, and `run` warns when it holds content from more than a day ago.

## v0.2.0 - 2026-10-07

### Added

- **The Hub answers /api/health** (HMD-19). `GET /api/health` needs no token and returns `200` with `{"database":"ok","version":"<version>"}` when the database answers, or `503` with `{"database":"not answering","version":"<version>"}` when it fails or takes more than 2 seconds. Fleet's Service health check polls it.
- **The Hub rolls Vitals up into 5-minute buckets** (HMD-22). Each stored sample updates its System's UTC-aligned 5-minute bucket in the same transaction, keeping count, min, sum, and max of CPU busy, memory used, and 1-minute load, plus the largest memory total, the smallest uptime, the Collector's footprint, and each disk's largest used and total. Resent samples never count twice, late samples land in their own bucket, and upgrading backfills the buckets from the samples already stored.
- **The Hub prunes old Vitals** (HMD-23). While `heimdall-hub serve` runs, about once an hour it deletes raw Vitals samples older than 14 days and rollups older than a year, so retention needs no separate unit. A failed prune logs one warning and the next hour tries again.
- **Collector and Hub install and supervise their own systemd user unit on Linux** (HMD-20). `heimdall-hub service` and `heimdall-collector service` gain `install`, `uninstall`, `start`, `stop`, `restart`, and `status`. `install` writes `~/.config/systemd/user/com.dbtlr.heimdall.<hub|collector>.service` only when it changed, enables it, and restarts the binary; only a compiled binary may install or uninstall. `status` always exits 0 and reports the unit, the Hub's health and running version (`restart pending` when it differs from the binary on disk), and the Collector's queue. `heimdall-hub service install --port N` stores the port in `hub.toml` only when the file holds another value. See [ADR-0007](docs/decisions/0007-binaries-own-their-service-config-file-holds-settings.md).
- **Runtime logs carry timestamps and rotate themselves** (HMD-20). Every runtime line `serve` and `run` log starts with an ISO 8601 UTC time and goes to stdout; fatal startup lines carry the time too and go to stderr. The supervised log is `~/.local/state/heimdall/hub.log` or `collector.log`; the binary copies it to `.1` and empties it when its first line is 90 days old or it reaches 10 MB.
- **Collector and Hub install and supervise their own launchd user agent on macOS** (HMD-21). The same `service` commands work on macOS: `install` writes `~/Library/LaunchAgents/com.dbtlr.heimdall.<hub|collector>.plist` only when it changed, loads it into the user's GUI domain, and restarts the binary, which logs to the same `~/.local/state/heimdall/` path as on Linux. The agent runs while the user is logged in. `stop` unloads the agent, so launchd does not relaunch it, and `status` reads its state from `launchctl print` and always exits 0. See [ADR-0007](docs/decisions/0007-binaries-own-their-service-config-file-holds-settings.md).
- **Systems pair with the Hub** (HMD-27). `heimdall-hub pair <system>` prints a single-use Pairing code, such as `7K3M-Q9XA`, that expires after 10 minutes, and `POST /api/v1/pair` redeems it for the System's name and a new token. Pairing a paired System again rotates its token, and `heimdall-hub unpair <system>` revokes it and keeps the System's history. Every failed redemption gets the same answer, and the Hub refuses redemptions after 10 failures in a minute. See [ADR-0009](docs/decisions/0009-collectors-pair-with-the-hub.md).
- **Collectors pair with the Hub** (HMD-28). `heimdall-collector pair <code>` redeems a Pairing code from `heimdall-hub pair <system>` and keeps the System's name and token in `identity.json` in the state directory, readable by its owner alone, bound to the origin of the Hub that issued them. `run` reports as that System, refuses to start until it is paired, and refuses to send its token to a Hub of another origin, so moving to a new Hub means pairing again. `heimdall-collector service status` names the paired System and its Hub, flags a configured Hub of another origin, or says it is not paired. See [ADR-0009](docs/decisions/0009-collectors-pair-with-the-hub.md).

### Changed

- **Collector and Hub read their configuration from ~/.config/heimdall/** (HMD-18). The Collector looks for `.config/heimdall/collector.toml` or `.json`, and the Hub for `.config/heimdall/hub.toml` or `.json`, in the working directory and then the home directory. This is where Fleet renders the files. Move an existing `~/.heimdall-collector.toml` or `~/.heimdall-hub.toml` to the new path, because the old names are no longer read.
- **The Hub authenticates Reports by the tokens in its database** (HMD-27). It keeps only their SHA-256 hashes, so adding or revoking a System needs no restart, and `serve` counts paired Systems as it starts.
- **The Hub reads its database URL from `[database] url`** (HMD-27). Move a top-level `database` key in `hub.toml` into a `[database]` table as `url`. `--database` and `HEIMDALL_DATABASE_URL` are unchanged.

### Removed

- **The Hub's `tokens` setting and `--token` option** (HMD-27). Existing installs pair each System once instead, and the Collectors that used configured tokens stop authenticating until they pair.
- **The Collector's `--system` and `--token` options** (HMD-28), with `HEIMDALL_SYSTEM`, `HEIMDALL_TOKEN`, and the `system` and `token` keys in `collector.toml`. `collector.toml` holds only `hub` and an optional `stateDir`, the same on every System. Existing installs pair each System once; `run` ignores the old keys, which can be deleted.

## v0.1.0 - 2026-10-06

### Added

- **Releases for every platform** (HMD-11). A tagged release publishes the Collector and Hub binaries for darwin-arm64, linux-x64, and linux-arm64 with `SHA256SUMS` and notes. `install-collector.sh` and `install-hub.sh` install a verified binary at a pinned release, which is how Fleet installs and updates Heimdall. See [Releasing](docs/releasing.md).

### Changed

- **Version line names the release with a `v`** (HMD-11). `--version` prints `heimdall-collector v0.1.0 (Report schema v1)`, Loom's standard form, and the Hub prints the same.
