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

- **Fleet overview** (`/`): every paired System as a lane on one time axis, and the Conditions open now. A lane names its worst open warning or alert, with `+N` for other current warnings or alerts and `+N?` for other evidence old or unknown. Notes stay visible and leave the System healthy. Old or unknown evidence never lowers a stored Condition's level. Open now lists observations, first detection, and latest check, with links to System detail. Items with evidence old or unknown appear separately, retaining any stored Hub level. Evidence without a Hub Condition keeps its unknown mark. A link below the lanes adds unpaired Systems, greyed, with their Conditions tagged `unpaired`; the link sets `?unpaired` for sharing. With no paired System, the page says "No System is paired." When paired Systems have yet to report, their Never seen lanes remain under "No System has reported yet."
- **System detail** (`/systems/<name>`): each open Condition or evidence item shows its subject, expected and observed state, first detection, latest check, and next step. Rows open to evidence and commands; a link's `#` anchor opens its row. Vitals, Harness processes, Sessions, and Conditions share one axis. The facts card shows load averages, disks colored by their open Hub Condition levels, and Harness installs. Condition bars show each recorded level, and the Timeline groups raised, level-changed, and cleared transitions by occurrence, newest occurrence first. Within an occurrence, transitions follow the Hub's recording order. Migrated historical levels are labeled "Backfilled level". An unpaired System opens under a banner explaining that its history is kept and no new Reports arrive. An unknown System name is not found.
- **Session** (`/systems/<name>/sessions/<harness>/<source>/<session id>`): one Session's Timeline, Cost, and Trace.

The Hub sets every Condition's level: note, warning, or alert ([ADR-0017](../../docs/decisions/0017-the-hub-sets-condition-levels.md)). The dashboard reads stored levels and transitions from one consistent database snapshot. Disk limits and per-System overrides belong in the Hub configuration.

Every page but the Session page reads its data again every 15 seconds while its tab is visible, through the router's invalidation, and at once when the tab becomes visible again. A tick that finds the previous load still running is skipped.

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
