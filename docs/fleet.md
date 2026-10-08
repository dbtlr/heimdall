---
description: "How Fleet declares Heimdall: Application Units for both binaries, config templates with one 1Password secret, native Service Units, the one-time pairing of each System, the operations Fleet runs, the Inventory Fleet publishes, and the asks Fleet has not yet met."
---

# How Fleet declares Heimdall

Fleet installs and operates Heimdall, and it declares the Hub and the Collector the same way it declares Mimir. This document holds everything the Fleet repository needs: the Application Units, the config templates, the native Service Units, and the one step an operator takes to pair each System. Each section follows Fleet's `docs/specs/units.md`, and the declarations are modeled on Mimir's under `apps/mimir/` and `services/mimir/`.

The example System names are `laptop-1` and `server-1`. `server-1` is the System that hosts the Hub. Replace them with the names in Fleet's own repository.

Heimdall ships two binaries, and each is its own Application:

| Application          | Binary               | Runs on                      | Fleet Service        |
| -------------------- | -------------------- | ---------------------------- | -------------------- |
| `heimdall`           | `heimdall-hub`       | the System that hosts the Hub | `heimdall`           |
| `heimdall-collector` | `heimdall-collector` | every System                 | `heimdall-collector` |

[ADR-0007](decisions/0007-binaries-own-their-service-config-file-holds-settings.md) records why each binary installs and supervises its own Service and why Fleet renders every setting. [ADR-0009](decisions/0009-collectors-pair-with-the-hub.md) records why no per-System secret is rendered.

## Applications

Fleet declares each binary as an Application in `apps/<name>/app.toml`. The Collector's declaration, `apps/heimdall-collector/app.toml`, looks like this:

```toml
[targets]
systems = ["laptop-1", "server-1"]

[release]
repository = "dbtlr/heimdall"
default_channel = "stable"

[install]
script_url = "https://raw.githubusercontent.com/dbtlr/heimdall/{version}/install-collector.sh"
version_env = "HEIMDALL_VERSION"

[version]
command = ["sh", "-c", "\"$HOME/.local/bin/heimdall-collector\" --version | awk '{ print $2 }'"]

[update]
command = ["sh", "-c", "curl -fsSL \"https://raw.githubusercontent.com/dbtlr/heimdall/$0/install-collector.sh\" | HEIMDALL_VERSION=\"$0\" sh"]
version_args = ["{version}"]
```

The Hub's declaration, `apps/heimdall/app.toml`, differs in its targets, which name only the System that hosts the Hub, and in its script: `install-hub.sh` in place of `install-collector.sh`, and `heimdall-hub` in place of `heimdall-collector`.

The version line is `heimdall-collector v0.2.0 (Report schema v1)`. The version command prints its second word, and Fleet ignores the leading `v` when it compares that word with the tag. [Releasing](releasing.md) covers what a release publishes and the install scripts.

Each Application also declares its `[[configs]]`, described next.

## Config templates

Heimdall reads one file per binary, `~/.config/heimdall/hub.toml` and `~/.config/heimdall/collector.toml`. Fleet renders every setting into these files from a template, and it passes none to `service install`. Heimdall never modifies a rendered file: `service install` writes a setting only when its value changes, and Fleet gives it none, so Heimdall's own Drift check stays quiet.

The only secret in either file is the Hub's database URL. A System's name and token are not settings: each Collector receives them when the operator pairs the System, and keeps them in `identity.json` in its state directory ([Pairing a System](#pairing-a-system)).

Fleet resolves each `op://` reference on the Center, replaces the placeholder `{{ secret "<key>" }}` with the value as a quoted TOML string, and ships the file with its declared mode.

### Hub

In `apps/heimdall/app.toml`:

```toml
[[configs]]
source = "config/hub.toml.tmpl"
target = ".config/heimdall/hub.toml"
mode = "0600"

[configs.secrets.database_url]
ref = "op://fleet/shared-heimdall/database_url"
path = "database.url"
```

The template, `apps/heimdall/config/hub.toml.tmpl`:

```toml
host = "127.0.0.1"
port = 8080

[database]
url = {{ secret "database_url" }}
```

- `[database] url` is a PostgreSQL URL. The Hub applies its own migrations at start. Fleet's `path` must be a dotted TOML path of at least two segments, which is why the URL sits under `[database]` and not at the top level.
- `host` stays on loopback. Tailscale ingress reaches the Hub through Fleet's Service Unit, not through the listener's address.
- `port` must equal `port` in the Hub's per-System Service file, which the health check and the ingress use. Both files hold the literal number, on the one System that hosts the Hub.
- The file holds no token. The Hub keeps only hashes of the tokens it issues, in its database.

### Collector

In `apps/heimdall-collector/app.toml`:

```toml
[[configs]]
source = "config/collector.toml.tmpl"
target = ".config/heimdall/collector.toml"
mode = "0600"
```

The template, `apps/heimdall-collector/config/collector.toml.tmpl`, holds no secret and renders the same on every System:

```toml
hub = "http://hub-host.example.ts.net:8080"
```

- `hub` is the Hub's tailnet ingress URL: the host name of the System that hosts the Hub and the `tailnet_port` of the Hub's Service file. Fleet's native Services publish `tailnet_port` as raw TCP inside the tailnet, so the scheme is `http`.
- `stateDir` is optional and absent here. The default is `$XDG_STATE_HOME/heimdall`, which is `~/.local/state/heimdall` on Linux, and `~/Library/Application Support/heimdall` on macOS.
- A Collector sends its token only to the Hub it paired with, so a wrong `hub` cannot send a token elsewhere: `run` refuses when the origin (scheme, host, and port) differs from the one in `identity.json`.

One secret reference serves every System an Application targets, and Fleet renders no per-System values. Pairing makes them unnecessary.

## Native Services

Each binary has a native Service Unit. Fleet runs the declared `install`, `restart`, and `status` commands as the System's `package_user`, and the binary writes and supervises its own systemd user unit. Fleet keeps release selection, configuration, Tailscale ingress, and the HTTP health check ([Fleet ADR-0021](https://github.com/dbtlr/fleet/blob/main/docs/decisions/0021-applications-own-native-service-lifecycles.md)). Native Services run only on Linux today.

### Hub

`services/heimdall/service.toml`:

```toml
description = "Heimdall Hub"
supervisor = "native"

[targets]
systems = ["server-1"]

[binary]
app = "heimdall"

[native]
install = ["{home}/.local/bin/heimdall-hub", "service", "install"]
restart = ["{home}/.local/bin/heimdall-hub", "service", "restart"]
status = ["{home}/.local/bin/heimdall-hub", "service", "status"]
log = "{home}/.local/state/heimdall/hub.log"

[ingress]
tailnet_port = "{tailnet_port}"
port = "{port}"

[health]
url = "http://127.0.0.1:{port}/api/health"

[[requires]]
path = "{home}/.local/bin/heimdall-hub"
kind = "executable"

[[requires]]
path = "{home}/.config/heimdall/hub.toml"
kind = "file"
mode = "0600"
owner = "{package_user}"
```

The per-System file, `services/heimdall/server-1.toml`, holds the values for that System:

```toml
home = "/home/example"
port = 8080
tailnet_port = 8080
```

`port` here and `port` in `hub.toml` are two literals on the one System that hosts the Hub, and they must match.

`GET /api/health` answers 200 with `{"database":"ok","version":"<version>"}` when the database answers and 503 when it does not. Fleet polls the URL until it returns 200, so a Hub that cannot reach its database fails `install` and `restart`.

### Collector

`services/heimdall-collector/service.toml`:

```toml
description = "Heimdall Collector"
supervisor = "native"

[targets]
systems = ["laptop-1", "server-1"]

[binary]
app = "heimdall-collector"

[native]
install = ["{home}/.local/bin/heimdall-collector", "service", "install"]
restart = ["{home}/.local/bin/heimdall-collector", "service", "restart"]
status = ["{home}/.local/bin/heimdall-collector", "service", "status"]
log = "{home}/.local/state/heimdall/collector.log"

[[requires]]
path = "{home}/.local/bin/heimdall-collector"
kind = "executable"

[[requires]]
path = "{home}/.config/heimdall/collector.toml"
kind = "file"
mode = "0600"
owner = "{package_user}"
```

The Collector listens on no port, so the Service declares no `[ingress]` and no `[health]`. Fleet's schema makes both tables optional: `[ingress]` and `[health]` are each marked optional in `docs/specs/units.md`, and a Service without them skips ingress and polls no URL. The Collector's health is the queue line in `service status`: the number of samples waiting for the Hub. A Collector that cannot reach the Hub shows a growing queue, and a Collector that is not paired says `not paired` with how to pair it.

Each System that runs a Collector has a per-System file, `services/heimdall-collector/laptop-1.toml`:

```toml
home = "/home/example"
```

A System runs the Service when Targeting matches and its per-System file exists.

### macOS

Fleet's Service Units require a Linux System, so Fleet cannot yet run the Collector on a Mac. The Collector's own `service install` writes and loads a launchd user agent, so on a Mac the operator pairs the System, then runs it by hand once after Fleet installs the binary and renders the config:

```sh
~/.local/bin/heimdall-collector service install
```

`install` restarts the Collector, so run it again after each update to load the new binary. Fleet's Darwin support is ask A4 below.

## Pairing a System

Fleet renders no token. An operator pairs each System with the Hub once, and the Hub keeps only hashes of the tokens it issues ([ADR-0009](decisions/0009-collectors-pair-with-the-hub.md)):

1. On the System that hosts the Hub, run `heimdall-hub pair laptop-1`, with the System's Fleet name. It prints a Pairing code such as `7K3M-Q9XA`, valid for 10 minutes.
2. On `laptop-1`, run `heimdall-collector pair 7K3M-Q9XA`. The Collector redeems the code and keeps the System name and token in `identity.json` in its state directory, which `pair` writes readable by its owner alone. If the file or directory later becomes readable or writable by others, `run` warns and carries on. It prints `Paired as laptop-1.`
3. On `laptop-1`, run `heimdall-collector service restart`, or `service install` when Fleet has not installed the Service yet.

Until a System is paired, its Collector refuses to run and `service status` says `not paired`. The Hub's own System pairs the same way, with both commands run there. Pairing needs no Hub restart.

Repeat the steps for a System when:

- Its state directory is wiped, which loses `identity.json` along with the queue.
- The operator rotates its token. Pairing a paired System again issues a new token, and the old one works until the new code is redeemed. `heimdall-hub unpair laptop-1` revokes a token without a replacement.
- The Hub moves to a new address. A token goes only to the Hub that issued it, so every System pairs again with the new Hub.

Fleet need not render or store a token, and no 1Password item exists per System. Fleet may run the same two commands itself later (see [Open asks](#open-fleet-side-asks)).

## Operations Fleet must run

- **Pass no settings to `service install`.** Fleet renders every setting, and `install` then leaves the rendered file untouched. `install` always restarts the Service, so run it again, or `restart`, after an update or a new config file.
- **Never edit `identity.json`.** It belongs to the Collector, in its state directory, and Fleet neither renders nor captures it.
- **Add a System without restarting the Hub.** Pairing takes effect at once, so a new System needs no Hub restart.
- **Show `status` verbatim.** `service status` always exits 0, whatever it finds, because Fleet aborts on any other exit code. A stopped or missing unit appears in the text, not in the exit code. The Hub's status adds its health and the version that runs, with `restart pending` when that differs from the binary on disk. The Collector's adds the System it paired as, the Hub it paired with, and its queue.
- **Install a release binary.** A binary built from source refuses `service install` and `uninstall`. The release binaries Fleet installs are compiled.
- **Linger must be on for the package user.** The user unit starts at boot and survives logout only with linger. Fleet enables it at `install`, and `status` notes when it is off.
- **Leave log rotation to Heimdall.** Each binary rotates its own log under `~/.local/state/heimdall/` after 90 days or 10 MB, so Fleet needs no `logrotate` entry.

## The Inventory

Fleet publishes the whole-fleet Inventory to the Hub as one JSON document ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)). Its JSON Schema is [`packages/schema/inventory.v1.schema.json`](../packages/schema/inventory.v1.schema.json). Fleet fetches it at the release tag the Hub runs, such as `https://raw.githubusercontent.com/dbtlr/heimdall/<tag>/packages/schema/inventory.v1.schema.json`, and can validate an Inventory before it publishes.

| Field | Holds |
| --- | --- |
| `schemaVersion` | `1`. |
| `commit` | The full 40-character SHA of the commit on Fleet's main branch that Fleet compiled the Inventory from. |
| `systems` | Every declared System: `name`, `os` (`darwin` or `linux`), `tags`, and the Units that Fleet's targeting applies to it. |
| `systems[].applications` | `name`, `repository` as `owner/name`, `channel` (`stable` or `next`), and `release`, the tag the channel resolved to when Fleet published. |
| `systems[].services` | `name` and `supervisor` (`systemd`, `docker`, or `native`). |
| `systems[].backupJobs` | `name`, `schedule` as a list of `{ "hour", "minute" }` times in the System's local time, and `retentionDays`. |
| `systems[].harnesses` | The Harness names the System declares, such as `claude-code`. |
| `databases` | Each database in Fleet's PostgreSQL registry: `name`, `role`, and `system`, the System that hosts it. |

Every field is required, and lists may be empty, except that the Inventory names at least one System and every Backup Job runs at least once. The Hub records when it stored the Inventory, so the Inventory carries no time of its own. It also carries no commands, config templates, secret references, or observed state.

The Hub refuses an Inventory that fails the schema, including one with a field the schema does not name. It also refuses these, which the JSON Schema cannot express:

- A name that repeats among the Systems, or among one System's Applications, Services, Backup Jobs, or Harnesses.
- A time that repeats in one Backup Job's schedule.
- A database name or role that repeats on one System.
- A database whose System the Inventory does not declare.

A new optional field keeps `schemaVersion`; a rename, a removal, or a change of meaning bumps it. Either way, upgrade the Hub before Fleet publishes the new field or version. The Hub refuses a version it does not know and says so.

## Open Fleet-side asks

These are the gaps between Heimdall's needs and what Fleet's documents and renderer show today. Each is an ask in Fleet's `docs/specs/heimdall-asks.md`; A5 to A7 follow ADR-0010.

- **Darwin user agents (A4).** Native Service Units must run on a macOS System, so that `fleet service heimdall-collector <system> install` runs the Collector's launchd install and reports its status. Until then an operator runs `service install` by hand.
- **An account on a System without one (A4).** A System that declares no `package_user` has no unprivileged account to run the Collector as a systemd user service. It joins Heimdall when Fleet gives it one.
- **Publish the Inventory (A5, M3).** Each Fleet command that changes a System reads the stored commit with `heimdall-hub inventory current` over SSH on the System that hosts the Hub, checks that its own commit descends from it (skipped when the Hub stores `none`), then runs `heimdall-hub inventory publish --expect-commit <stored commit or none>` with the whole-fleet Inventory on standard input ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)).
- **Install records (A6, M3).** Each Fleet command that installs an Application, Service, or Backup Job leaves a data-only install record on the System, which the Collector checks.
- **Run records (A7, M3).** Each Backup Job keeps a run record of its latest run and latest successful run: start, finish, exit status, and newest archive.
- **Automated pairing (optional, later).** Fleet could run `heimdall-hub pair <system>` and `heimdall-collector pair <code>` for a System that is not paired. Fleet has no cross-System imperative step today, and a System pairs only once, so the manual step stands until the effort pays.

Ask A3, per-System secrets and plain values in one template, is no longer needed. Pairing replaced the per-System token and System name, and the Hub's `port` and `tailnet_port` stay literals on the one System that hosts the Hub.
