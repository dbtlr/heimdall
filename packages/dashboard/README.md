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

On phones, a raised tab bar at the bottom links to Fleet, Services, Agents, and Timeline. Each tab fills a quarter of the bar's width, shows an icon over its label, and turns the primary color when it is the current page. The bar sits above the device's bottom safe area. Compare and System pages keep Fleet selected. Wider screens show the same links in the header.

At 1024 px and wider, a fixed left sidebar replaces the header's brand, links, and fleet verdict. It shows the brand with the fleet verdict, then Fleet with the count of paired Systems, and under it every System: paired ones in tile order, unpaired ones last and dimmed. A System row shows its health glyph, time since Last seen, worst problem, and thin CPU, memory, and disk bars, and links to the System, keeping the tab and range on a System page. Services, Agents, and Timeline follow, and the version sits at the bottom. The current page is highlighted, and on a System page Fleet is bold while the System's row is highlighted. All pages share one content frame, up to 1400 px wide; the header stays only where it holds range pickers, and a System page's tabs align left, with its Fleet link and System pills left to the sidebar. The sidebar's Systems are read with every page; a browser narrower than 1024 px skips that read after the first load, and if the read fails the sidebar shows its links without Systems.

- **Fleet overview** (`/`): the header's right end holds the fleet verdict, "All clear" when no paired item is at alert or warning level, else the count of each open level. Each System is a tile, alerts before warnings and awake before asleep, with its health glyph (a moon while asleep), the time since Last seen (or, while its alerts are silenced, a crossed-out bell with the time left), and CPU, memory, and disk meters that take the level of an open Condition on that resource. The disk meter reads the mount its worst low disk Condition names, else the fullest disk, and Vitals older than the quiet limit are muted. A tile names its worst open alert or warning with `+N` for the others, and a dashed `N?` for evidence old or unknown. Notes leave a System healthy and gather under the tiles in a "Can wait" list, except paired Systems' Service restarted notes, which live on Services. A strip under the header says when alert delivery is failing. A link opens Compare on one time axis. Unpaired Systems retain their history under a separate section with `?unpaired`; their Conditions never affect the paired verdict. From 1024 px up, the page shows what Compare shows instead of tiles: a header with the range picker, each paired System as a lane on one time axis, and Open now; `?unpaired` adds the unpaired lanes. Only a browser at that width reads the lanes, so a phone never does.
- **Services** (`/services`): every Service record mirrored for a paired System, plus forgotten Services with an open Service down Condition or Service restarted note, one row per System and Service. Rows sort down, restarted, up, then unknown, followed by Service and System name. Open Service down wins over Service restarted; without either, a Service is up only when its System was heard from within the two-minute quiet limit, its checks are not old beside its Last seen (the rule that raises checks missing), at least one check exists, and every held check is up. Stale or missing evidence is unknown. Down rows show time since the Condition opened; restarted rows show the latest Service stop. Each row shows the Service's installed version the Hub derived, or a muted "unknown". Each row opens its Service page. Filter opens a sheet with multi-select Status and System chips, counts constrained by the other section, and Show N Services. Zero-count chips remain selectable. Active filters appear as removable pills, and Clear removes all. The `status` and `system` arrays in the URL preserve filters for bookmarks and browser history. The Services tab's badge counts Services with an open Service down Condition or Service restarted note, once per System and Service across paired Systems, and hides at zero.
- **Compare** (`/compare`): every paired System as a lane on one time axis, and the Conditions open now. A lane names its worst open warning or alert, with `+N` for other current warnings or alerts and `+N?` for other evidence old or unknown. Notes stay visible and leave the System healthy. Old or unknown evidence never lowers a stored Condition's level. Open now lists observations, first detection, and latest check, with links to each Condition's page. Items with evidence old or unknown appear separately, retaining any stored Hub level. Evidence without a Hub Condition keeps its unknown mark. A link below the lanes adds unpaired Systems, greyed, with their Conditions tagged `unpaired`; the link sets `?unpaired` for sharing. With no paired System, the page says "No System is paired." When paired Systems have yet to report, their Never seen lanes remain under "No System has reported yet."
- **Fleet Timeline** (`/timeline`): Condition occurrences across all Systems, including labelled unpaired history. It includes occurrences cleared in the last 7 days and every still-open occurrence. Newest occurrences appear first in Hub recording order; a level change does not reorder an occurrence. Raised, level-changed, and cleared transitions keep their recording order and backfilled labels. Each occurrence links to its page. System links open that System's Timeline tab. From 1024 px up the page is a table, one row per occurrence under Today, Yesterday, or dated day headings, with each occurrence's transitions inline.
- **System detail** (`/systems/<name>`): a sticky Fleet back link, System status, and System pills lead five tabs. Pills list paired Systems and retain the current unpaired System when viewing its history. Switching Systems keeps the tab and range and clears the sample selection.
  - **Now** opens by default with open Conditions and uncertain evidence, excluding paired Systems' Service restarted notes, followed by a compact Vitals glance. Each Condition expands to its evidence and next step, and links to its page. A link's `#` anchor opens that item in place. Vitals always say "Last reported" with their sample time; a System's clock alone cannot prove freshness. From 1024 px up, four cards (CPU busy, memory, disk, load) with CPU and memory lines over the loaded range replace the glance above, and each Condition is one table-like row.
  - **Vitals** shows CPU, memory, and Condition spans on a common axis, followed by load averages and disks colored by their stored Hub levels.
  - **Sessions** shows Harness processes and Sessions on the same time axis. Extra Sessions and idle processes collapse.
  - **Records** shows what the provisioner recorded and collapses long lists of Harness installs and records.
  - **Timeline** groups raised, level-changed, and cleared transitions by occurrence, newest occurrence first. Extra occurrences collapse. Transitions preserve the Hub's recording order and label migrated levels "Backfilled level". Each occurrence links to its page.

  The `tab`, `range`, and `at` search parameters share the current view. Older links with `at` and no `tab` open Vitals. Changing tabs reuses the loaded history. Selecting a time opens a sample sheet on phones, with Close and Escape dismissal. Desktop shows the inspector beside the charts. Long expanded lists scroll within their sections. An unpaired System retains its history under an explanatory banner. An unknown System name is not found.
- **Condition** (`/systems/<name>/conditions/<id>`): one Condition occurrence, open or cleared, with a back link to its System. It leads with the culprit's number: disk used, CPU or memory busy share, a hot process's cores, or how long the Condition has been open for kinds without a reading. Disk, CPU, memory, and hot processes add a chart of the last 7 days (disk) or 24 hours, with a dashed line at each limit the Hub stores for the System and a caption stating the scale; without stored limits, the caption says the limits are unknown. A filling disk adds its growth per day and when it would be full, labelled Estimate. The level history lists each transition with the Hub's reason. An open Condition ends with its next step, and for a disk the readings at which it eases and clears. An unknown id, or one on another System, is not found.
- **Session** (`/systems/<name>/sessions/<harness>/<source>/<session id>`): one Session's Timeline, Cost, and Trace.
- **Service** (`/systems/<System>/services/<Service>`): one Service's recent Service stops and Service down Conditions, opened from Services or its name in a System page's Recorded panel. A Services back link and a System link in the subtitle keep both views reachable. It shows the supervisor and unit, the current checks, a line under them with the installed version and its upstream, or "Installed version unknown", and any Application the Service record names that the System has not recorded, a 90-day strip with a tick per stop (taller for more restarts, in the serious color for a failure), and the Service's history: its stops, its Service down raises and clears, and its installed version changes of the 90 days, newest first, each led by its date and time in the viewer's zone. A stop still under way and a Service down still open stay however old. The newest 6 show, and Show N older opens the rest. A stop opens to when it stopped and ran again, its result, restarts, and when it was sent and received; a Service down raise shows its reason and how long the Service was down, and either transition opens its Condition's page; an installed version change shows the version it replaced, and the first version the Hub saw is not a change. A link opens the open Service restarted note. A Service forgotten by its provisioner still opens while it has stops, a Service down in its history, or an open Service Condition; one with none of these, or an unknown System, is not found.
- **Agents** (`/agents`): list-price cost across the archived fleet for Today, the last 7 days, or the last 30 days. Today starts at midnight in the viewer's time zone, including on days when clocks change. The other periods are trailing durations of 168 and 720 hours. Only requests inside the period count, including subagents' requests and history from unpaired Systems. The total, the breakdown, and Session amounts use that same period. Any unpriced request labels the amount "At least" and adds an unpriced-request count. Sessions sort by their priced amount, highest first, and link to their Session pages. "Active recently" means a request was recorded within the past 60 seconds; it does not assert that a Session is running. Other rows show when their last request was recorded.

The cost card breaks the period's cost down four ways, chosen with its switch and kept in the URL as `by`: `project` (the default), `system`, `model`, or `harness`. A stacked bar and a ranked list show each row's share and priced cost, highest first. The top five rows take the series colors and the rest share a neutral one; the list shows eight rows before the rest fold into a count. A row with unpriced requests reads "At least", and one with none priced reads "No list price", with a note that unpriced requests may change the shares and order. Tapping a row sets `pick` in the URL and filters the Sessions list to that project, System, Harness, or, for the model breakdown, the Sessions that used that model; their amounts still cover the whole period, so under a model a Session's amount includes what its other models cost. Tapping the row again, or the chip above the list, clears the pick; changing `by` or the range clears it too. Sessions with no working directory and requests with an empty model have the empty `pick`.

The model breakdown reads the Hub's stored per-Session model totals for Sessions whose request spans fit inside the period, and prices requests for those crossing a boundary, as for Session totals. Stored model totals are refreshed with the Session totals, so they have the same refresh lag.

The Agents view reads stored totals for Sessions whose request spans fit inside the period. Sessions crossing either boundary read and price only requests inside it. Its stored spans and totals have the same refresh lag as other pages. After a price change, boundary amounts can reflect the new prices while stored totals still use the old prices. A refresh brings them into agreement; a backlog can take several refreshes. The fleet total always sums the displayed amounts. The page waits for the browser's time zone before displaying totals, and the range and zone travel in its URL, together with the breakdown and its pick.

The Hub sets every Condition's level: note, warning, or alert ([ADR-0017](../../docs/decisions/0017-the-hub-sets-condition-levels.md)). The dashboard reads stored levels and transitions from one consistent database snapshot. Disk limits and per-System overrides belong in the Hub configuration.

Every page but the Session page reads its data again every 15 seconds while its tab is visible, through the router's invalidation, and at once when the tab becomes visible again. A tick that finds the previous load still running is skipped.

The Agents query benchmark runs against a disposable test database with 800 Sessions and 200,000 requests:

```sh
bun packages/dashboard/scripts/benchmark-agents.ts
```

It checks request counts against the fixture facts and reports the first read, warm median, and worst duration for each period. It uses the test PostgreSQL harness and never reads `HEIMDALL_DATABASE_URL`.

## Mobile status area

Mobile headers use an opaque raised surface and leave the top safe area clear.
The viewport uses `viewport-fit=cover`; page content also respects the left and right safe areas.
A real fixed element paints the top edge, including at least 6 pixels on narrow screens and devices with a coarse pointer.
Wide screens with a fine pointer paint only the reported top inset, leaving desktop scrolling content clear.
This gives Safari a persistent background to sample for its status area while the page scrolls.
Keep that element opaque and free of filters; a pseudo-element or a `theme-color` tag alone does not provide the same sampling target.

Check native status-area behavior in an installed iOS web app after layout changes.
Desktop browser emulation can verify spacing and scrolling, but cannot reproduce iOS's status-bar gradient.

## Seed a scratch database

`scripts/seed.ts` fills a scratch Hub database through the Hub's migration and ingest code. It creates four paired Systems, one unpaired System, a week of Vitals, Sessions, processes, records, runs, checks, and Harness installs. `workstation-1` has disk Conditions at all three levels, one occurrence that escalates from note through warning to alert, and a backfilled historical level. `gateway-1` has only a disk note and remains healthy. `workstation-1`'s syncthing has five Service stops (a killed one received hours late, a failed restart storm, a clean one, one with an unknown result, and a failure minutes ago after one restart) and an open Service restarted note. Other examples include a stopped Service, failing and overdue jobs, Drift, an unreadable file, and a Condition resting on old evidence. Reseeding resets these Systems and their transition history. The script refuses a database holding any other System. Point it at a scratch database, never a real Hub's:

```sh
HEIMDALL_DATABASE_URL=postgres://localhost/heimdall_scratch bun run --cwd packages/dashboard seed
```

## Browser interaction tests

The Service filter sheet's DOM tests use a Chromium executable without extra packages.
Set `HEIMDALL_TEST_BROWSER` to its path, or put `chromium` or `google-chrome` on `PATH`:

```sh
HEIMDALL_TEST_BROWSER=/path/to/chromium bun test packages/dashboard/src/components/service-filters.dom.test.ts
```

The root verification also runs these tests when a browser is available; otherwise it skips them.
They cover draft selection, Escape and backdrop dismissal, applying filters, reopening, and clearing URL parameters.

## Layout

- `src/main.ts`, `src/application.ts`, and `src/cli/`: the `heimdall-dashboard` command line. `main.ts` is the entry point, `application.ts` declares the command and adds the shared `service` commands, and `cli/` holds `serve`.
- `src/routes/`: pages and the API routes. `src/routeTree.gen.ts` is generated by TanStack Router; commit it, and do not edit it.
- `src/components/`: the page's components, small and each doing one thing. `src/lib/` holds the pure helpers they share (time formatting, axis ticks, lane text), each with a `bun:test` test.
- `src/server/`: server-only code. Query functions take a `SQL` and are tested against the Hub's own test harness; a server function is a thin wrapper around one.
- `src/components/ui/`: shadcn/ui components, added with `bunx shadcn@latest add <name>`. They are excluded from the repository's lint.
- `src/styles.css`: the theme, as Tailwind and shadcn CSS variables, and the Barlow Semi Condensed font from Fontsource.
- `public/`: the icons, served at fixed paths. `favicon.svg` is the source. `favicon.ico` holds its 32 px render, and `apple-touch-icon.png` is a 180 px render of it as a full square, without the rounded corners and border, since iOS rounds the corners itself. Render both again when the SVG changes.
