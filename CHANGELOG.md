---
description: "Released Heimdall changes, compiled from changelog fragments at each release cut."
---

# Changelog

Notable changes to the Collector and the Hub, in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Heimdall is pre-1.0, so a minor release can break compatibility.

This file holds released sections only. Pending entries live in [`.changes/`](.changes/README.md) until a release cut compiles them ([Releasing](docs/releasing.md)).

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
