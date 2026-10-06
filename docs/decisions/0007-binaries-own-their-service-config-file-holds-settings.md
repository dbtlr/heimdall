---
type: adr
title: ADR-0007 - Each binary installs and supervises its own Service, and its config file is the one home for its settings
description: "The Collector and the Hub each install, run, and report their own systemd user unit or launchd user agent through a shared service package. The unit carries no settings: both binaries read ~/.config/heimdall/, and service install writes a setting there only when its value changes."
status: proposed
created: 2026-10-06
modified: 2026-10-06
---

# Each binary installs and supervises its own Service, and its config file is the one home for its settings

## Context

Fleet runs the Hub and the Collector as Applications with native Services (Fleet ADR-0021). A native Service is supervised by the Application itself. Fleet calls the binary's `install`, `restart`, and `status` commands as the System's package user, renders the Application's config file from a template with 1Password secrets, and checks an HTTP health URL on loopback. Fleet's native Services run only on Linux today, and the Collector on a Mac still needs a launchd user agent.
Fleet's per-System Service file already holds values such as the port that its ingress and health check use, and its config templates render the files each Application reads.
Mimir follows the same pattern with its own `service` commands. Loom has no service plugin.
Both binaries look up their config file with Loom's configuration plugin: the file `--config` names, or else a relative path tried in the working directory and then in home.

## Decision

- **Each binary supervises itself.** `heimdall-hub` and `heimdall-collector` each have `service install | uninstall | start | stop | restart | status`. On Linux, `install` writes and enables a systemd user unit. On macOS, it writes and bootstraps a launchd user agent. `status` reports the unit's state, and the Hub's also reports its health endpoint.
- **One shared service package.** A workspace package defines the supervisor interface with a systemd backend, a launchd backend, and a fake for tests. Both binaries use it, so the two never grow separate service code.
- **The config file is the one home for settings.** The Hub reads `~/.config/heimdall/hub.toml` and the Collector reads `~/.config/heimdall/collector.toml`, found by Loom's lookup from home. The unit starts in home and runs plain `serve` or `run`, so a hand run and a supervised run read the same file. The unit carries no flags and no environment.
- **`service install` writes a setting only when it changes.** `heimdall-hub service install --port N` stores the port in `hub.toml`. When the file already holds that value, `install` leaves the file untouched. Fleet renders every setting into the template and passes none to `install`, so the file Fleet manages stays exactly as Fleet rendered it.
- **A build from source never touches the real supervisor by accident.** `install` and `uninstall` from a build that is not a release refuse unless explicitly told to proceed, and tests run against the fake supervisor.
- **Logs go to `~/.local/state/heimdall/`** at an absolute path Fleet's native Service can declare, and rotate every 90 days.
- **The Hub serves `GET /api/health`**: 200 when its database answers, 503 when it does not.

## Considered options

- A launchd adapter in Fleet for the Collector on macOS. Rejected: Fleet ADR-0021 gives Service lifecycle to the Application, and an adapter would make macOS the one platform where Heimdall's unit is written somewhere else.
- A service plugin in Loom first. Deferred: it would be the shared home for every Loom application, but it would put Heimdall's rollout on Loom's release schedule. The package can move into Loom later without changing the commands.
- Settings in the unit, such as `serve --port N`. Rejected: a hand run and the supervised run could read different settings without anyone noticing.
- Config files as dotfiles in home (`~/.heimdall-hub.toml`). Rejected: Fleet renders Application config under `~/.config/<app>/`, as it does for Mimir.

## Consequences

Moving the config file is a breaking change for installs made before it, and the changelog tells operators to move theirs.
The Hub loads its tokens only at start, so Fleet restarts the Hub when it renders a new token list.
If `install` rewrote a Fleet-rendered file, Heimdall's own Drift check would report it. Writing only on change, with Fleet passing no settings, prevents that.
