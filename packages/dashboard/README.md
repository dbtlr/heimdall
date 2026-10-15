# Heimdall dashboard

The web app that shows the fleet. It is a TanStack Start app (React, Tailwind CSS v4, shadcn/ui) that reads the Hub's PostgreSQL database directly through server functions and never writes to it. See [ADR-0015](../../docs/decisions/0015-dashboard-is-its-own-app-reading-the-hubs-database.md).

It runs under Bun, like the Hub, and uses Bun's built-in `SQL`.

## Database URL

The app reads the URL of the Hub's database from the first of these that is set:

1. The `HEIMDALL_DATABASE_URL` environment variable.
2. `[database] url` in the Hub's config file, `~/.config/heimdall/hub.toml`.

The app opens the connection on the first request, so it starts and builds without a database.

## Run

Run these from the repository root, after `bun install`.

| Task                                                | Command                                  |
| --------------------------------------------------- | ---------------------------------------- |
| Develop, on <http://localhost:3000>                 | `bun run --cwd packages/dashboard dev`   |
| Build the app into `.output/`                       | `bun run --cwd packages/dashboard build` |
| Serve the built app from source                     | `bun run --cwd packages/dashboard start` |
| Build the app and compile `dist/heimdall-dashboard` | `bun run build:dashboard`                |

`dev` and `build` run Vite under the Bun runtime (`bun --bun vite`), and the build uses Nitro's `standard` preset with the static assets inlined, so `.output/` holds a server that needs no files beside it. `bun run build:dashboard` builds the app and compiles it into `dist/heimdall-dashboard`, a single self-contained binary. `start` runs `bun src/main.ts serve`, which serves the built `.output/` from source, so run `build` first. The dev server takes `--port`.

## Settings

`heimdall-dashboard serve` serves the pages, the server functions, `GET /api/health`, and the records read, `GET /api/v1/records` ([Reading the records back](../../docs/spec.md#reading-the-records-back)). Both API routes answer any method but GET and HEAD with 405. Each setting comes from its flag, then its environment variable, then `~/.config/heimdall/dashboard.toml`:

| Flag     | Variable                  | File key | Default     |
| -------- | ------------------------- | -------- | ----------- |
| `--host` | `HEIMDALL_DASHBOARD_HOST` | `host`   | `127.0.0.1` |
| `--port` | `HEIMDALL_DASHBOARD_PORT` | `port`   | `3000`      |

A port of 0 picks a free one. The file holds no secret, and the database URL is not one of its settings: it comes from the section above.

The dashboard's HTTP idle timeout is 60 seconds, allowing slow page queries to finish before the connection closes.
The database statement timeout remains 30 seconds. The Hub retains its 10-second HTTP idle timeout.

`GET /api/health` answers 200 with `{"database":"ok","version":"<version>"}` when the Hub's database answers within 2 seconds, and 503 with `{"database":"not answering","version":"<version>"}` when it does not or no URL is configured.

## Run as a Service

`heimdall-dashboard service install | uninstall | start | stop | restart | status` work as the Hub's do, through the `@heimdall/service` package: a systemd user unit on Linux and a launchd user agent on macOS, named `com.dbtlr.heimdall.dashboard`. The unit runs `serve` from home and appends to `~/.local/state/heimdall/dashboard.log`, which the binary rotates itself. `service install --port N` stores `port = N` in `dashboard.toml` only when it changes. `status` always exits 0 and shows the unit's state, a `health` line asked of `http://127.0.0.1:<port>/api/health` (with `restart pending` when the running version differs from the binary), and the unit, log, and config paths. Only a compiled binary may `install` or `uninstall`. The README at the repository root covers the commands, and [Running Heimdall with Fleet](../../docs/fleet.md) the declarations that install the dashboard.

## Pages

On phones, a fixed bottom bar links to Fleet, Agents, and Timeline, with space for the device safe area. Compare and System pages keep Fleet selected. Wider screens show the same links in the header.

- **Fleet overview** (`/`): a verdict identifies the worst open Hub level, naming the System when only one has that level or counting the Systems when several do. Alerts precede warnings regardless of evidence freshness; each card names its System, culprit, evidence, latest check, and next step, and opens the Condition on System detail. Notes and evidence without a Hub Condition collapse separately. System cards show counts by level, dated CPU and memory readings, the fullest disk and its mount, and CPU history over the selected range on a fixed 0–100% scale, with 5-minute averages and breaks for missing samples. Systems needing action come first. Sleeping Systems are dimmed, and sleep never lowers an open Condition. A link opens Compare on one time axis. Unpaired Systems retain their history under a separate section with `?unpaired`; their Conditions never affect the paired Fleet verdict.
- **Compare** (`/compare`): every paired System as a lane on one time axis, and the Conditions open now. A lane names its worst open warning or alert, with `+N` for other current warnings or alerts and `+N?` for other evidence old or unknown. Notes stay visible and leave the System healthy. Old or unknown evidence never lowers a stored Condition's level. Open now lists observations, first detection, and latest check, with links to System detail. Items with evidence old or unknown appear separately, retaining any stored Hub level. Evidence without a Hub Condition keeps its unknown mark. A link below the lanes adds unpaired Systems, greyed, with their Conditions tagged `unpaired`; the link sets `?unpaired` for sharing. With no paired System, the page says "No System is paired." When paired Systems have yet to report, their Never seen lanes remain under "No System has reported yet."
- **Fleet Timeline** (`/timeline`): Condition occurrences across all Systems, including labelled unpaired history. It includes occurrences cleared in the last 7 days and every still-open occurrence. Newest occurrences appear first in Hub recording order; a level change does not reorder an occurrence. Raised, level-changed, and cleared transitions keep their recording order and backfilled labels. System links open that System's Timeline tab.
- **System detail** (`/systems/<name>`): a sticky Fleet back link, System status, and System pills lead five tabs. Pills list paired Systems and retain the current unpaired System when viewing its history. Switching Systems keeps the tab and range and clears the sample selection.
  - **Now** opens by default with open Conditions and uncertain evidence, followed by a compact Vitals glance. Each Condition expands to its evidence and next step. A link's `#` anchor opens its Condition. Vitals always say "Last reported" with their sample time; a System's clock alone cannot prove freshness.
  - **Vitals** shows CPU, memory, and Condition spans on a common axis, followed by load averages and disks colored by their stored Hub levels.
  - **Sessions** shows Harness processes and Sessions on the same time axis. Extra Sessions and idle processes collapse.
  - **Records** shows what the provisioner recorded and collapses long lists of Harness installs and records.
  - **Timeline** groups raised, level-changed, and cleared transitions by occurrence, newest occurrence first. Extra occurrences collapse. Transitions preserve the Hub's recording order and label migrated levels "Backfilled level".

  The `tab`, `range`, and `at` search parameters share the current view. Older links with `at` and no `tab` open Vitals. Changing tabs reuses the loaded history. Selecting a time opens a sample sheet on phones, with Close and Escape dismissal. Desktop shows the inspector beside the charts. Long expanded lists scroll within their sections. An unpaired System retains its history under an explanatory banner. An unknown System name is not found.
- **Session** (`/systems/<name>/sessions/<harness>/<source>/<session id>`): one Session's Timeline, Cost, and Trace.
- **Agents** (`/agents`): list-price cost across the archived fleet for Today, the last 7 days, or the last 30 days. Today starts at midnight in the viewer's time zone, including on days when clocks change. The other periods are trailing durations of 168 and 720 hours. Only requests inside the period count, including subagents' requests and history from unpaired Systems. The total, Claude Code and Codex split, and Session amounts use that same period. Any unpriced request labels the amount "At least" and adds an unpriced-request count. Sessions sort by their priced amount, highest first, and link to their Session pages. "Active recently" means a request was recorded within the past 60 seconds; it does not assert that a Session is running. Other rows show when their last request was recorded.

The Agents view reads stored totals for Sessions whose request spans fit inside the period. Sessions crossing either boundary read and price only requests inside it. Its stored spans and totals have the same refresh lag as other pages. After a price change, boundary amounts can reflect the new prices while stored totals still use the old prices. A refresh brings them into agreement; a backlog can take several refreshes. The fleet total always sums the displayed amounts. The page waits for the browser's time zone before displaying totals, and the range and zone travel in its URL.

The Hub sets every Condition's level: note, warning, or alert ([ADR-0017](../../docs/decisions/0017-the-hub-sets-condition-levels.md)). The dashboard reads stored levels and transitions from one consistent database snapshot. Disk limits and per-System overrides belong in the Hub configuration.

Every page but the Session page reads its data again every 15 seconds while its tab is visible, through the router's invalidation, and at once when the tab becomes visible again. A tick that finds the previous load still running is skipped.

The Agents query benchmark runs against a disposable test database with 800 Sessions and 200,000 requests:

```sh
bun packages/dashboard/scripts/benchmark-agents.ts
```

It checks request counts against the fixture facts and reports the first read, warm median, and worst duration for each period. It uses the test PostgreSQL harness and never reads `HEIMDALL_DATABASE_URL`.

## Seed a scratch database

`scripts/seed.ts` fills a scratch Hub database through the Hub's migration and ingest code. It creates four paired Systems, one unpaired System, a week of Vitals, Sessions, processes, records, runs, checks, and Harness installs. `workstation-1` has disk Conditions at all three levels, one occurrence that escalates from note through warning to alert, and a backfilled historical level. `gateway-1` has only a disk note and remains healthy. Other examples include a stopped Service, failing and overdue jobs, Drift, an unreadable file, and a Condition resting on old evidence. Reseeding resets these Systems and their transition history. The script refuses a database holding any other System. Point it at a scratch database, never a real Hub's:

```sh
HEIMDALL_DATABASE_URL=postgres://localhost/heimdall_scratch bun run --cwd packages/dashboard seed
```

## Layout

- `src/main.ts`, `src/application.ts`, and `src/cli/`: the `heimdall-dashboard` command line. `main.ts` is the entry point, `application.ts` declares the command and adds the shared `service` commands, and `cli/` holds `serve`.
- `src/routes/`: pages and the API routes. `src/routeTree.gen.ts` is generated by TanStack Router; commit it, and do not edit it.
- `src/components/`: the page's components, small and each doing one thing. `src/lib/` holds the pure helpers they share (time formatting, axis ticks, lane text), each with a `bun:test` test.
- `src/server/`: server-only code. Query functions take a `SQL` and are tested against the Hub's own test harness; a server function is a thin wrapper around one.
- `src/components/ui/`: shadcn/ui components, added with `bunx shadcn@latest add <name>`. They are excluded from the repository's lint.
- `src/styles.css`: the theme, as Tailwind and shadcn CSS variables, and the Barlow Semi Condensed font from Fontsource.
- `public/`: the icons, served at fixed paths. `favicon.svg` is the source. `favicon.ico` holds its 32 px render, and `apple-touch-icon.png` is a 180 px render of it as a full square, without the rounded corners and border, since iOS rounds the corners itself. Render both again when the SVG changes.
