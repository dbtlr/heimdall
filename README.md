# Heimdall

Observability for a small personal fleet. A Collector on each machine reports host vitals, agent sessions, and the state of everything Fleet manages to a Hub on Asgard, which serves a dashboard inside the tailnet.

Status: M1 (walking skeleton) in progress. See [docs/roadmap.md](docs/roadmap.md).

## Development

Heimdall is a Bun workspace with three packages: `packages/schema` (the Report wire schema), `packages/collector`, and `packages/hub`. Tool versions are pinned in `mise.toml`.

```sh
mise install
bun install
bun run verify           # format, lint, typecheck (vp check), then bun test
bun run fix              # apply formatting and lint fixes
bun run build:collector  # compile dist/heimdall-collector for this platform
```

## Running the Collector

`heimdall-collector run` samples the System's Vitals every 15 seconds and Pushes them to the Hub's ingest endpoint, `POST <hub>/api/v1/reports`, with the System's token as a bearer token. Samples wait in a SQLite queue in the state directory, which holds about 24 hours and keeps them across restarts, until the Hub accepts them.

Each setting comes from its flag, then its environment variable, then the configuration file:

| Flag          | Variable             | File key   | Default                                                                 |
| ------------- | -------------------- | ---------- | ----------------------------------------------------------------------- |
| `--hub`       | `HEIMDALL_HUB`       | `hub`      | none                                                                    |
| `--system`    | `HEIMDALL_SYSTEM`    | `system`   | none                                                                    |
| `--token`     | `HEIMDALL_TOKEN`     | `token`    | none                                                                    |
| `--state-dir` | `HEIMDALL_STATE_DIR` | `stateDir` | `~/Library/Application Support/heimdall` on macOS, `$XDG_STATE_HOME/heimdall` on Linux |

The configuration file is the one `--config` names, or else `.heimdall-collector.toml` or `.heimdall-collector.json` in the working directory and then the home directory. Supply the token through the file or the variable, because a flag is visible in the process table.

```toml
hub = "https://heimdall.example.ts.net/"
system = "db-mbp"
token = "…"
```

SIGTERM or SIGINT stops the Collector between samples with exit status 143 or 130; queued samples stay on disk for the next start.
