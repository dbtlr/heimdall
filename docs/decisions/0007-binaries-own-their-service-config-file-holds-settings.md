---
type: adr
title: ADR-0007 - Each binary installs and supervises its own Service, and its config file is the one home for its settings
description: "The Collector and the Hub each install, run, and report their own systemd user unit or launchd user agent through a shared service package. The unit carries no settings: both binaries read ~/.config/heimdall/, and service install writes a setting there only when its value changes."
status: accepted
created: 2026-10-06
modified: 2026-10-08
---

# Each binary installs and supervises its own Service, and its config file is the one home for its settings

## Context

Fleet runs the Hub and the Collector as Applications with native Services (Fleet ADR-0021). A native Service is supervised by the Application itself. Fleet calls the binary's `install`, `restart`, and `status` commands as the System's package user, renders the Application's config file from a template with 1Password secrets, and checks an HTTP health URL on loopback. Fleet's native Services run only on Linux today, and the Collector on a Mac still needs a launchd user agent.
Fleet's per-System Service file already holds values such as the port that its ingress and health check use, and its config templates render the files each Application reads.
Mimir follows the same pattern with its own `service` commands. Loom has no service plugin.
Both binaries look up their config file with Loom's configuration plugin: the file `--config` names, or else a relative path tried in the working directory and then in home.

## Decision

- **Each binary supervises itself.** `heimdall-hub` and `heimdall-collector` each have `service install | uninstall | start | stop | restart | status`. On Linux, `install` writes and enables a systemd user unit. On macOS, it writes and bootstraps a launchd user agent in the user's GUI domain. The unit is named `com.dbtlr.heimdall.hub` or `com.dbtlr.heimdall.collector` on both platforms. `install` converges: running it again rewrites the unit only if it changed, and restarts the binary.
- **`status` always exits 0.** Fleet prints its output verbatim and aborts on any other exit code, so a stopped or missing unit is reported in the text. It names the unit's state and its unit, log, and config paths. The Hub's adds its health and running version, with `restart pending` whenever the running and on-disk versions differ; the Collector's adds how many samples wait in its queue.
- **One shared service package.** A workspace package defines the supervisor interface with a systemd backend, a launchd backend, and a fake for tests. Both binaries use it, so the two never grow separate service code.
- **The config file is the one home for settings.** The Hub reads `~/.config/heimdall/hub.toml` and the Collector reads `~/.config/heimdall/collector.toml`, found by Loom's lookup from home. The unit starts in home and runs plain `serve` or `run`, so a hand run and a supervised run read the same file. The unit carries no flags and no environment.
- **`service install` writes a setting only when it changes.** `heimdall-hub service install --port N` stores the port in `hub.toml`. When the file already holds that value, `install` leaves the file untouched. Fleet renders every setting into the template and passes none to `install`, so the file Fleet manages stays exactly as Fleet rendered it.
- **Only a compiled binary touches the real supervisor.** `install` and `uninstall` refuse when the binary is not compiled, with no opt-in. A locally compiled binary counts, so trying the real supervisor during development means compiling first. Tests run against the fake supervisor.
- **Logs live in `~/.local/state/heimdall/` on every platform.** The supervisor appends each binary's output to `hub.log` or `collector.log` there, one path that a single Fleet declaration can name for every System. The binary rotates its own log: when its first line is 90 days old or the log reaches 10 MB, whichever comes first, it copies it to `.1` and truncates it in place. Every runtime log line starts with an ISO 8601 UTC timestamp.
- **The Hub serves `GET /api/health`**: 200 when its database answers, 503 when it does not, with a JSON body carrying the running version.

## Considered options

- A launchd adapter in Fleet for the Collector on macOS. Rejected: Fleet ADR-0021 gives Service lifecycle to the Application, and an adapter would make macOS the one platform where Heimdall's unit is written somewhere else.
- A service plugin in Loom first. Deferred: it would be the shared home for every Loom application, but it would put Heimdall's rollout on Loom's release schedule. The package can move into Loom later without changing the commands.
- Settings in the unit, such as `serve --port N`. Rejected: a hand run and the supervised run could read different settings without anyone noticing.
- An opt-in that lets a source build install a real unit. Rejected: Mimir added one and removed it, because a smoke test that passes the opt-in installs real units anyway.
- Rotation by `logrotate` or `newsyslog`. Rejected: each needs a root-owned config per platform, outside the Application's own lifecycle. The supervisor holds the log open, so rotation copies and truncates instead of renaming.
- Config files as dotfiles in home (`~/.heimdall-hub.toml`). Rejected: Fleet renders Application config under `~/.config/<app>/`, as it does for Mimir.

## Consequences

Moving the config file is a breaking change for installs made before it, and the changelog tells operators to move theirs.
The Hub loads its tokens only at start, so Fleet restarts the Hub when it renders a new token list.
If `install` rewrote a Fleet-rendered file, Heimdall's own Drift check would report it. Writing only on change, with Fleet passing no settings, prevents that.

## Changelog

- 2026-10-06: Accepted. The Linux lifecycle landed in HMD-20; the launchd backend follows in HMD-21.
- 2026-10-07: Addendum. The launchd backend landed in HMD-21.
- 2026-10-07: Addendum. The consequence that Fleet restarts the Hub for a new token list no longer applies: Systems pair with the Hub and their tokens live in its database ([ADR-0009](0009-collectors-pair-with-the-hub.md)), so adding a System needs no restart.
- 2026-10-08: Clarification. Heimdall's Drift check reports a rewritten file only when the provisioner recorded it as a `files` record ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)); the Collector no longer reads Fleet's `manifest.json`. The decision is unchanged.
