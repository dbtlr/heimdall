# Heimdall

Observability for a small personal fleet. A Collector on each machine reports host vitals, agent sessions, and the state of everything Fleet manages to a Hub, which serves a dashboard inside the tailnet.

Status: M1 (walking skeleton) is complete; M2 (Fleet rollout) is next. See [docs/roadmap.md](docs/roadmap.md).

## Development

Heimdall is a Bun workspace with five packages: `packages/schema` (the Report wire schema), `packages/collector`, `packages/hub`, `packages/service` (the `service` commands, runtime log lines, and log rotation both binaries share), and `packages/release` (the release tooling). Tool versions are pinned in `mise.toml`.

```sh
mise install
bun install
bun run verify           # format, lint, typecheck (vp check), then bun test
bun run fix              # apply formatting and lint fixes
bun run build:collector  # compile dist/heimdall-collector for this platform
bun run build:hub        # compile dist/heimdall-hub for this platform
```

A pull request that changes what ships adds a changelog fragment in [`.changes/`](.changes/README.md). [Releasing](docs/releasing.md) covers fragments, cutting a release, and installing the binaries.

The Hub's tests need PostgreSQL. They use the server `HEIMDALL_TEST_DATABASE_URL` names, or else start a throwaway cluster with the `initdb` and `pg_ctl` on `PATH`. Each test creates and drops its own database. Run `bun test` from the repository root or from `packages/hub`: Bun reads the preload that stops the throwaway cluster only from a directory with a `bunfig.toml`.

## Running the Collector

`heimdall-collector run` samples the System's Vitals every 15 seconds and Pushes them to the Hub's ingest endpoint, `POST <hub>/api/v1/reports`, with the System's token as a bearer token. Samples wait in a SQLite queue in the state directory, which holds about 24 hours and keeps them across restarts, until the Hub accepts them.

Each setting comes from its flag, then its environment variable, then the configuration file:

| Flag          | Variable             | File key   | Default                                                                 |
| ------------- | -------------------- | ---------- | ----------------------------------------------------------------------- |
| `--hub`       | `HEIMDALL_HUB`       | `hub`      | none                                                                    |
| `--system`    | `HEIMDALL_SYSTEM`    | `system`   | none                                                                    |
| `--token`     | `HEIMDALL_TOKEN`     | `token`    | none                                                                    |
| `--state-dir` | `HEIMDALL_STATE_DIR` | `stateDir` | `~/Library/Application Support/heimdall` on macOS, `$XDG_STATE_HOME/heimdall` on Linux |

The configuration file is the one `--config` names, or else `.config/heimdall/collector.toml` or `.config/heimdall/collector.json` in the working directory and then the home directory, which is `~/.config/heimdall/collector.toml`. Supply the token through the file or the variable, because a flag is visible in the process table.

```toml
hub = "https://heimdall.example.ts.net/"
system = "laptop-1"
token = "…"
```

SIGTERM or SIGINT stops the Collector between samples with exit status 143 or 130; queued samples stay on disk for the next start.

## Running the Hub

`heimdall-hub serve` applies any pending database migrations, then listens for Reports at `POST /api/v1/reports` and serves a page at `/` that lists every System with its last-seen time, status, and newest Vitals, followed by each System's Timeline of its latest 10 Conditions raised and cleared.

About once an hour, `serve` deletes raw Vitals samples older than 14 days and rollups older than a year, and logs only when that fails.

`GET /api/health` needs no token. It answers `200` with `{"database":"ok","version":"<version>"}` when the database answers a trivial query, and `503` with `{"database":"not answering","version":"<version>"}` when it fails or takes more than 2 seconds. Fleet's health check polls it, and `version` is the release `--version` prints.

| Flag         | Variable                | File key   | Default     |
| ------------ | ----------------------- | ---------- | ----------- |
| `--database` | `HEIMDALL_DATABASE_URL` | `database` | none        |
| `--host`     | `HEIMDALL_HOST`         | `host`     | `127.0.0.1` |
| `--port`     | `HEIMDALL_PORT`         | `port`     | `8080`      |
| `--token`    | none                    | `tokens`   | none        |

The configuration file is the one `--config` names, or else `.config/heimdall/hub.toml` or `.config/heimdall/hub.json` in the working directory and then the home directory, which is `~/.config/heimdall/hub.toml`. Each token entry is `system=token`, one per System. No two Systems may share a token, and a token holds no whitespace. Supply tokens through the file, because a flag is visible in the process table.

```toml
database = "postgres://heimdall@localhost/heimdall"
tokens = ["laptop-1=…", "server-1=…"]
```

The ingest endpoint answers 200 with the number of samples stored and skipped, 401 for a missing token, 403 for a token no System holds or a Report that names another System than its token's, 422 for an invalid Report, and 503 when the database cannot take it. Only 422 makes the Collector drop a Report ([ADR-0004](docs/decisions/0004-report-grows-additively-samples-keyed-by-system-and-time.md)). A Report rejected with 422, or with 403 for naming another System, still counts as seeing the System its token names and raises that System's Reports rejected Condition until a Report from it is stored ([ADR-0005](docs/decisions/0005-rejected-reports-count-as-seen-conditions-keep-a-timeline.md)).

SIGTERM or SIGINT stops the Hub with exit status 143 or 130.

## Running as a Service

Each binary installs and supervises itself as a systemd user unit on Linux ([ADR-0007](docs/decisions/0007-binaries-own-their-service-config-file-holds-settings.md)). The commands are the same for both, `heimdall-hub service <command>` and `heimdall-collector service <command>`. On macOS only `status` runs for now; the launchd user agent is not built yet.

| Binary               | Unit                           | Runs    | Log                                     | Config file                         |
| -------------------- | ------------------------------ | ------- | --------------------------------------- | ----------------------------------- |
| `heimdall-hub`       | `com.dbtlr.heimdall.hub`       | `serve` | `~/.local/state/heimdall/hub.log`       | `~/.config/heimdall/hub.toml`       |
| `heimdall-collector` | `com.dbtlr.heimdall.collector` | `run`   | `~/.local/state/heimdall/collector.log` | `~/.config/heimdall/collector.toml` |

- `install` creates the log directory and writes `~/.config/systemd/user/<unit>.service`, but only when its content changed, and then reloads the user manager. It enables the unit and always restarts it, which is how a new binary or a changed config file takes effect. Running it again with nothing changed rewrites nothing and restarts.
- `heimdall-hub service install --port N` first stores `port = N` in `~/.config/heimdall/hub.toml`, creating the file if it is missing. A file that already holds that port is left exactly as it is, and `install` refuses to create `hub.toml` beside an existing `hub.json`, which the new file would hide, so a file Fleet rendered stays as Fleet rendered it. No other setting goes through `install`.
- `uninstall` stops and disables the unit, deletes its file, and reloads the user manager. The config file, the log, and the Collector's queue stay.
- `start`, `stop`, and `restart` drive the installed unit, and exit 1 when none is installed.
- `status` prints plain text and always exits 0, because Fleet aborts on any other code. It names the unit's state and its unit, log, and config paths. The Hub's adds its health from `GET http://<host>:<port>/api/health`, with the host and port the Hub reads from its config file and loopback in place of a wildcard host, asked when the unit runs or its state is unknown, and the version that runs, with `restart pending` when that differs from the binary on disk. The Collector's adds how many samples wait in its queue. It notes when linger is off for the user, because the unit then stops at logout; turn it on with `loginctl enable-linger`.

The unit runs `<absolute path of the binary> serve` or `run` from home, with no flags and no environment, so a hand run and the supervised run read the same config file. It restarts the binary 10 seconds after any exit and never gives up; exit status 143 or 130, after SIGTERM or SIGINT, counts as a clean stop.

Only a compiled binary may `install` or `uninstall`, and there is no opt-in. A run from source, such as a test, refuses before it touches the user manager. To try the real supervisor during development, compile first with `bun run build:hub` or `bun run build:collector` and run the binary from `dist/`.

`serve` and `run` write their runtime lines to stdout, each starting with an ISO 8601 UTC time, and the unit appends both output streams to the log. Fatal startup lines on stderr carry the time too. The binary rotates its own log before it writes its first line and about once a day after: when the first line is 90 days old or the log reaches 10 MB, it copies the log to `<log>.1`, replacing the previous copy, and empties the log in place.
