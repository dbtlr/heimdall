# Heimdall

Observability for a small personal fleet. A Collector on each machine reports host vitals, agent sessions, and the state of everything Fleet manages to a Hub, which serves a dashboard inside the tailnet.

Status: M1 (walking skeleton) and M2 (Fleet rollout) are complete; M3 (Fleet state) is next. See [docs/roadmap.md](docs/roadmap.md).

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

The Hub's tests need PostgreSQL. They use the server `HEIMDALL_TEST_DATABASE_URL` names, or else start a throwaway cluster with the `initdb` and `pg_ctl` on `PATH`. Each test creates and drops its own database. The Collector's end-to-end pairing tests run against the same test Hub. Run `bun test` from the repository root, `packages/hub`, or `packages/collector`: Bun reads the preload that stops the throwaway cluster only from a directory with a `bunfig.toml`.

## Running the Collector

`heimdall-collector run` samples the System's Vitals every 15 seconds and Pushes them to the Hub's ingest endpoint, `POST <hub>/api/v1/reports`, as the System it paired as, with that System's token as a bearer token. Samples wait in a SQLite queue in the state directory, which holds about 24 hours and keeps them across restarts, until the Hub accepts them.

Each setting comes from its flag, then its environment variable, then the configuration file:

| Flag          | Variable             | File key   | Default                                                                 |
| ------------- | -------------------- | ---------- | ----------------------------------------------------------------------- |
| `--hub`       | `HEIMDALL_HUB`       | `hub`      | none                                                                    |
| `--state-dir` | `HEIMDALL_STATE_DIR` | `stateDir` | `~/Library/Application Support/heimdall` on macOS, `$XDG_STATE_HOME/heimdall` on Linux |

The configuration file is the one `--config` names, or else `.config/heimdall/collector.toml` or `.config/heimdall/collector.json` in the working directory and then the home directory, which is `~/.config/heimdall/collector.toml`. It holds no secret and is the same on every System:

```toml
hub = "http://hub-host.example.ts.net:8080"
```

### Pairing a new System

The Collector learns which System it is, and the token it authenticates with, by pairing with the Hub once ([ADR-0009](docs/decisions/0009-collectors-pair-with-the-hub.md)):

1. On the System that hosts the Hub, run `heimdall-hub pair <system>` with the new System's Fleet name, such as `laptop-1`. It prints a Pairing code such as `7K3M-Q9XA`.
2. On the new System, run `heimdall-collector pair <code>` within 10 minutes. It reads the Hub's URL and the state directory the way `run` does, redeems the code, and prints `Paired as laptop-1.`
3. Run `heimdall-collector service install` to start the Collector as a Service.

[Pairing a System](#pairing-a-system) describes the codes and the Hub's side.

`pair` keeps the System name and token, with the origin (scheme, host, and port) of the Hub that issued them, in `identity.json` in the state directory, readable by its owner alone, creating the directory private to its owner when it is missing, and writes it only after the Hub accepts the code. A refused or expired code, a Hub that has paused pairing, or a Hub it cannot reach exits 1 and leaves any identity it held as it was. `pair` never prints the code or the token. Pairing a paired System again rotates its token; restart a running Collector afterwards with `heimdall-collector service restart`.

`run` refuses to start without an identity and says to run `heimdall-collector pair <code>`. The identity is bound to its Hub: when the configured `hub` has another origin, `run` refuses before it sends anything, so the token never reaches another Hub, and the System pairs again with the new Hub. A `hub` that differs only in its path, such as a trailing slash or a path prefix, is the same Hub. It warns, and still runs, when `identity.json` is not private: when group or others have any access to it, can write to the state directory, or when another user owns it. Wiping the state directory loses the identity as well as the queue, and the System pairs again.

SIGTERM or SIGINT stops the Collector between samples with exit status 143 or 130; queued samples stay on disk for the next start.

## Running the Hub

`heimdall-hub serve` applies any pending database migrations, then listens for Reports at `POST /api/v1/reports`, redeems Pairing codes at `POST /api/v1/pair`, and serves a page at `/` that lists every System with its last-seen time, status, and newest Vitals, followed by each System's Timeline of its latest 10 Conditions raised and cleared. Its first line names the address it listens on and how many Systems are paired.

About once an hour, `serve` deletes raw Vitals samples older than 14 days and rollups older than a year, and logs only when that fails.

`GET /api/health` needs no token. It answers `200` with `{"database":"ok","version":"<version>"}` when the database answers a trivial query, and `503` with `{"database":"not answering","version":"<version>"}` when it fails or takes more than 2 seconds. Fleet's health check polls it, and `version` is the release `--version` prints.

| Flag         | Variable                | File key         | Default     |
| ------------ | ----------------------- | ---------------- | ----------- |
| `--database` | `HEIMDALL_DATABASE_URL` | `[database] url` | none        |
| `--host`     | `HEIMDALL_HOST`         | `host`           | `127.0.0.1` |
| `--port`     | `HEIMDALL_PORT`         | `port`           | `8080`      |

`pair` and `unpair` read `--database` the same way and ignore the host and port. The configuration file is the one `--config` names, or else `.config/heimdall/hub.toml` or `.config/heimdall/hub.json` in the working directory and then the home directory, which is `~/.config/heimdall/hub.toml`. Top-level keys come before the `[database]` table:

```toml
host = "127.0.0.1"
port = 8080

[database]
url = "postgres://heimdall@localhost/heimdall"
```

### Pairing a System

Each System pairs with the Hub once, and the Hub keeps only SHA-256 hashes of the tokens and codes it issues ([ADR-0009](docs/decisions/0009-collectors-pair-with-the-hub.md)). Pairing works whether `serve` runs or not, and needs no restart.

1. On the System that hosts the Hub, run `heimdall-hub pair <system>` with the System's Fleet name, such as `laptop-1`. It prints a Pairing code such as `7K3M-Q9XA` and when the code expires.
2. On that System, run `heimdall-collector pair <code>` within 10 minutes. The Collector redeems the code and keeps the System name and token it receives.

A code redeems once, reads in any case with the dash optional, and expires 10 minutes after it is issued. A later `pair` for the same System replaces its unredeemed code. `pair` for a System that is paired already rotates its token: the old token works until the new code is redeemed. `heimdall-hub unpair <system>` revokes the System's token and withdraws its pending code, and keeps its history on the page. It exits 1 when the System holds neither. Like `serve`, `pair` and `unpair` first apply any pending database migrations.

`POST /api/v1/pair` needs no token. It takes `{"code":"7K3M-Q9XA"}` and answers `200` with `{"system":"laptop-1","token":"…"}`, where the token is 32 random bytes in base64url. Every failure, whether the code is malformed, unknown, expired, or already used, answers `400` with `{"error":"invalid or expired code"}`. After 10 failed redemptions in a rolling minute across the Hub, it answers `429` with a `Retry-After` header and does not read the code until a failure ages out. Successful redemptions do not count.

The ingest endpoint answers 200 with the number of samples stored and skipped, 401 for a missing token, 403 for a token no paired System holds or a Report that names another System than its token's, 422 for an invalid Report, and 503 when the database cannot take it. Only 422 makes the Collector drop a Report ([ADR-0004](docs/decisions/0004-report-grows-additively-samples-keyed-by-system-and-time.md)). A Report rejected with 422, or with 403 for naming another System, still counts as seeing the System its token names and raises that System's Reports rejected Condition until a Report from it is stored ([ADR-0005](docs/decisions/0005-rejected-reports-count-as-seen-conditions-keep-a-timeline.md)).

SIGTERM or SIGINT stops the Hub with exit status 143 or 130.

## Running as a Service

Each binary installs and supervises itself as a systemd user unit on Linux and a launchd user agent on macOS ([ADR-0007](docs/decisions/0007-binaries-own-their-service-config-file-holds-settings.md)). The commands are the same for both binaries and both platforms, `heimdall-hub service <command>` and `heimdall-collector service <command>`, and so is the log path.

| Binary               | Unit                           | Runs    | Log                                     | Config file                         |
| -------------------- | ------------------------------ | ------- | --------------------------------------- | ----------------------------------- |
| `heimdall-hub`       | `com.dbtlr.heimdall.hub`       | `serve` | `~/.local/state/heimdall/hub.log`       | `~/.config/heimdall/hub.toml`       |
| `heimdall-collector` | `com.dbtlr.heimdall.collector` | `run`   | `~/.local/state/heimdall/collector.log` | `~/.config/heimdall/collector.toml` |

- `install` creates the log directory and, on Linux, writes `~/.config/systemd/user/<unit>.service`, but only when its content changed, and then reloads the user manager. It enables the unit and always restarts it, which is how a new binary or a changed config file takes effect. Running it again with nothing changed rewrites nothing and restarts.
- `heimdall-hub service install --port N` first stores `port = N` in `~/.config/heimdall/hub.toml`, creating the file if it is missing. A file that already holds that port is left exactly as it is, and `install` refuses to create `hub.toml` beside an existing `hub.json`, which the new file would hide, so a file Fleet rendered stays as Fleet rendered it. No other setting goes through `install`.
- On Linux, `uninstall` stops and disables the unit, deletes its file, and reloads the user manager. The config file, the log, and the Collector's queue stay.
- `start`, `stop`, and `restart` drive the installed unit, and exit 1 when none is installed.
- `status` prints plain text and always exits 0, because Fleet aborts on any other code. It names the unit's state and its unit, log, and config paths. The Hub's adds its health from `GET http://<host>:<port>/api/health`, with the host and port the Hub reads from its config file and loopback in place of a wildcard host, asked when the unit runs or its state is unknown, and the version that runs, with `restart pending` when that differs from the binary on disk. The Collector's adds the System it is paired as and the Hub it paired with, flags a configured Hub of another origin, or says `not paired` with how to pair it, and how many samples wait in its queue. It never shows the token. On Linux it notes when linger is off for the user, because the unit then stops at logout; turn it on with `loginctl enable-linger`.

The unit runs `<absolute path of the binary> serve` or `run` from home, with no flags and no environment, so a hand run and the supervised run read the same config file. The systemd unit restarts the binary 10 seconds after any exit and never gives up; exit status 143 or 130, after SIGTERM or SIGINT, counts as a clean stop.

On macOS the unit is `~/Library/LaunchAgents/<unit>.plist`, loaded into the user's GUI domain, `gui/<uid>`, as Mimir's agent is. It runs only while the user is logged in and loads again at each login. The plist runs the same command from home with no environment, appends both output streams to the same log, and has launchd relaunch the binary after any exit, at most once every 10 seconds.

- `install` enables the agent and always restarts the binary. When the plist changed and the agent is loaded, it first boots the agent out and waits up to 15 seconds for launchd to let it go. Only then does it write the new plist, so a failure leaves the old one and the next `install` tries again. A changed plist, or an agent that is not loaded, is bootstrapped, which starts the binary. An unchanged, loaded agent restarts with `launchctl kickstart -k`.
- `stop` boots the agent out of the GUI domain, because launchd would relaunch a stopped process, and leaves the plist in place. `start` bootstraps it again. `restart` kills and relaunches a loaded agent and bootstraps one that is not loaded. A stopped agent loads again at the next login.
- `uninstall` boots the agent out and deletes the plist. The config file, the log, and the Collector's queue stay.
- `status` reads `launchctl print` and changes nothing. A stopped agent reads `not loaded, stopped`. When the user has no GUI login session, it notes that the agent loads when the user logs in.

[How Fleet declares Heimdall](docs/fleet.md) covers the Application declarations, config templates, and native Services Fleet uses to run both binaries.

Only a compiled binary may `install` or `uninstall`, and there is no opt-in. A run from source, such as a test, refuses before it touches the user manager. To try the real supervisor during development, compile first with `bun run build:hub` or `bun run build:collector` and run the binary from `dist/`.

`serve` and `run` write their runtime lines to stdout, each starting with an ISO 8601 UTC time, and the unit appends both output streams to the log. Fatal startup lines on stderr carry the time too. The binary rotates its own log before it writes its first line and about once a day after: when the first line is 90 days old or the log reaches 10 MB, it copies the log to `<log>.1`, replacing the previous copy, and empties the log in place.
