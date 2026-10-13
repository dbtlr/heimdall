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

`GET /api/health` answers 200 with `{"database":"ok","version":"<version>"}` when the Hub's database answers within 2 seconds, and 503 with `{"database":"not answering","version":"<version>"}` when it does not or no URL is configured.

## Run as a Service

`heimdall-dashboard service install | uninstall | start | stop | restart | status` work as the Hub's do, through the `@heimdall/service` package: a systemd user unit on Linux and a launchd user agent on macOS, named `com.dbtlr.heimdall.dashboard`. The unit runs `serve` from home and appends to `~/.local/state/heimdall/dashboard.log`, which the binary rotates itself. `service install --port N` stores `port = N` in `dashboard.toml` only when it changes. `status` always exits 0 and shows the unit's state, a `health` line asked of `http://127.0.0.1:<port>/api/health` (with `restart pending` when the running version differs from the binary), and the unit, log, and config paths. Only a compiled binary may `install` or `uninstall`. The README at the repository root covers the commands, and [Running Heimdall with Fleet](../../docs/fleet.md) the declarations that install the dashboard.

## Pages

- **Fleet overview** (`/`): every paired System as a lane on one time axis, and the Conditions open now. When the Hub holds Systems that are no longer paired, a link below the lanes adds them under a divider, greyed, with their Conditions in Open now tagged `unpaired`; the link sets `?unpaired`, so the view can be shared. With no lanes to draw, the page says "No System is paired." or, when paired Systems have yet to send a Report, "No System has reported yet."
- **System detail** (`/systems/<name>`): the System's Vitals, Harness processes, Sessions, and Conditions on one axis, with a card of its load averages, disks (orange below 10% free, where the Hub raises low disk), and Harness installs. An unpaired System opens read-only under a banner; a name that is no System is not found.
- **Session** (`/systems/<name>/sessions/<harness>/<source>/<session id>`): one Session's Timeline, Cost, and Trace.

Every page reads its data again every 15 seconds while its tab is visible, through the router's invalidation, and at once when the tab becomes visible again.

## Seed a scratch database

`scripts/seed.ts` fills a scratch Hub database with four paired Systems and one unpaired System (`build-2`, silent for 9 hours, with an open Condition), a week of Vitals, agent Sessions with their processes' CPU and memory, the records, job runs, checks, and Harness installs that `workstation-1` and `server-1` report (`server-1` has a stopped Service, a failing job, and a drifted file; `workstation-1` has a nearly full mount; `gateway-1` reports no Harnesses), and Conditions that name them, through the Hub's own migration and ingest code. It resets what it wrote, so run it again for a fresh fleet, and it refuses a database that holds a System it did not seed. Point it at a scratch database, never a real Hub's:

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
