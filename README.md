# Heimdall

Observability for a small personal fleet. A Collector on each machine reports host vitals, agent sessions, and the state of everything Fleet manages to a Hub, which serves a dashboard inside the tailnet.

Status: M1 (walking skeleton) is complete; M2 (Fleet rollout) is next. See [docs/roadmap.md](docs/roadmap.md).

## Development

Heimdall is a Bun workspace with four packages: `packages/schema` (the Report wire schema), `packages/collector`, `packages/hub`, and `packages/release` (the release tooling). Tool versions are pinned in `mise.toml`.

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
