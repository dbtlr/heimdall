---
description: "How Fleet declares Heimdall: Application Units for both binaries, config templates with one 1Password secret, native Service Units, the one-time pairing of each System, the operations Fleet runs, the Inventory Fleet publishes, the install and run records Fleet leaves on each System, and the asks Fleet has not yet met."
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

Fleet publishes the whole-fleet Inventory to the Hub as one JSON document ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)). Its JSON Schema is [`packages/schema/inventory.v1.schema.json`](../packages/schema/inventory.v1.schema.json). Fleet fetches it at the release tag the Hub runs, such as `https://raw.githubusercontent.com/dbtlr/heimdall/<tag>/packages/schema/inventory.v1.schema.json`, and can validate an Inventory before it publishes. Its patterns are ECMA-262 regular expressions, as JSON Schema specifies. A validator that runs them as Python regular expressions lets `$` match before a final newline, so it accepts a value such as `"laptop-1\n"` that the Hub refuses.

| Field | Holds |
| --- | --- |
| `schemaVersion` | `1`. |
| `commit` | The full 40-character SHA of the commit on Fleet's main branch that Fleet compiled the Inventory from. |
| `systems` | Every declared System: `name`, `os` (`darwin` or `linux`), `tags` (each non-empty), and the Applications, Services, Backup Jobs, and Harnesses that Fleet's targeting applies to it. |
| `systems[].applications` | `name`, `repository` as `owner/name`, `channel` (`stable` or `next`), and `release`, the tag the channel resolved to when Fleet published. |
| `systems[].services` | `name` and `supervisor` (`systemd`, `docker`, or `native`). |
| `systems[].backupJobs` | `name`, `schedule` as a list of `{ "hour", "minute" }` times in the System's local time, and `retentionDays`, from 1 to 3650. |
| `systems[].harnesses` | The Harness names the System declares, such as `claude-code`. |
| `databases` | Each database in Fleet's PostgreSQL registry: `name`, `role`, and `system`, the System that hosts it. |

Every field is required, and lists may be empty, except that the Inventory names at least one System and every Backup Job runs at least once. The Hub records when it stored the Inventory, so the Inventory carries no time of its own. It also carries no commands, config templates, secret references, or observed state.

The Hub refuses an Inventory that fails the schema, including one with a field the schema does not name. It also refuses these, which the JSON Schema cannot express:

- A name that repeats among the Systems, or among one System's Applications, Services, or Backup Jobs.
- A database name or role that repeats on one System.
- A database whose System the Inventory does not declare.

A new optional field keeps `schemaVersion`; a rename, a removal, or a change of meaning bumps it. Either way, upgrade the Hub before Fleet publishes the new field or version. The Hub refuses a version it does not know and says so.

## Install records and run records

Fleet leaves data-only records on each System, and the Collector reads them with `manifest.json` ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)). An install record says what Fleet installed. A run record says how a Backup Job's runs went. Their JSON Schemas are [`packages/schema/install-record.v1.schema.json`](../packages/schema/install-record.v1.schema.json) and [`packages/schema/run-record.v1.schema.json`](../packages/schema/run-record.v1.schema.json). As with the Inventory, their patterns are ECMA-262 regular expressions. Python's `re` differs: `$` matches before a final newline, and `\d` matches digits beyond ASCII, so a Python validator accepts some records Heimdall refuses.

### Where they live

The records live in `~/.fleet/`, beside `manifest.json`, in the home of the account the System's `ssh` alias logs into, which is the `package_user` when the System declares one. Each record belongs to that account and is readable by it, even when Fleet installed the thing as root through `admin_ssh`, as it does for a `systemd` Service.

| Path | Holds |
| --- | --- |
| `~/.fleet/installed/applications/<name>.json` | The install record of the Application `<name>`. |
| `~/.fleet/installed/services/<name>.json` | The install record of the Service `<name>`. |
| `~/.fleet/installed/backup-jobs/<name>.json` | The install record of the Backup Job `<name>`. |
| `~/.fleet/backup-runs/<name>.json` | The run record of the Backup Job `<name>`. |

Each kind has its own directory because an Application and a Service can share a name, as `heimdall` does. The file name is the record's `name` with `.json` appended.

Fleet writes each record as one JSON object, first to a temporary file in the same directory and then moved into place with `mv`, so the Collector never reads half a record. The files may be readable by their owner alone, because the Collector runs as the same account.

- **Install records.** Fleet writes one after a command that installs or updates an Application, a Service Unit, or a Backup Job succeeds, including through `upgrade`. A later install replaces the record. The Services that Fleet's own commands handle, such as `t3code` and `proxy`, get no record, as they are not in the Inventory. Removing the installed thing removes its record.
- **Run records.** The Backup Job's runner writes one after every run, including a run that refuses to start, such as when its volume is not mounted. It writes nothing when the run stops because another run holds the lock, so it cannot overwrite the record the running one will write. It carries `latestSuccess` forward from the record it replaces when the run fails.

A System whose Collector runs as another account, such as a System without a `package_user`, has no records that Collector can read. It reports none, and the Hub judges no install gaps for it.

### Install record fields

Every install record carries these fields:

| Field | Holds |
| --- | --- |
| `schemaVersion` | `1`. |
| `kind` | `application`, `service`, or `backup-job`. |
| `name` | The Application, Service, or Backup Job name Fleet declares. |
| `commit` | The full 40-character SHA of the Fleet commit the command ran from, with Fleet's `-dirty` suffix when the tree was dirty. |
| `installedAt` | When the install finished, in UTC to the whole second, such as `2026-10-08T03:22:21Z`, as `manifest.json` writes `installedAt`. |

Each kind adds its own:

| Kind | Field | Holds |
| --- | --- | --- |
| `application` | `release` | The release tag Fleet installed, or `null` when Fleet did not resolve one, as for an update with `--raw`. |
| `service` | `supervisor` | `systemd`, `docker`, or `native`. |
| `service` | `unit` | For `systemd` only, the system unit Fleet renders, such as `notes.service`. |
| `service` | `container` | For `docker` only, the container Fleet runs under the account's rootless Docker, such as `fleet-notes`. |
| `service` | `healthUrl` | Optional. The `[health] url` Fleet rendered and polls. It must be `http://127.0.0.1:<port>`, optionally followed by a path, because the Collector requests it. |
| `service` | `port` | Optional. The `[ingress] port` the Service listens on. |
| `backup-job` | `supervisor` | `launchd`, the only scheduler Fleet runs Backup Jobs under. |
| `backup-job` | `label` | The launchd label Fleet installed the job under. |
| `backup-job` | `schedule` | The installed `{ "hour", "minute" }` times, in the System's local time, as in the Inventory. |
| `backup-job` | `retentionDays` | The installed retention, from 1 to 3650. |
| `backup-job` | `destination` | The absolute path of the directory the job writes its archives to. |

A `native` Service records neither `unit` nor `container`, because its Application writes and names its own unit. A Service that declares neither `[health]` nor `[ingress]` leaves out `healthUrl` and `port`.

The install record of a `systemd` Service, `~/.fleet/installed/services/notes.json`:

```json
{
  "schemaVersion": 1,
  "kind": "service",
  "name": "notes",
  "commit": "3f1c2a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  "installedAt": "2026-10-08T03:22:21Z",
  "supervisor": "systemd",
  "unit": "notes.service",
  "healthUrl": "http://127.0.0.1:8080/api/health",
  "port": 8080
}
```

### Run record fields

| Field | Holds |
| --- | --- |
| `schemaVersion` | `1`. |
| `name` | The Backup Job's name. |
| `latestRun` | The latest run, successful or not. |
| `latestSuccess` | The latest run that exited 0, or `null` until the job first succeeds. |

Each run holds `startedAt` and `finishedAt` in UTC to the whole second, `exitStatus` from 0 to 255, and `archive`. `archive` is the `name` and `sizeBytes` of the archive the run wrote, where `name` is a file name in the job's destination, in printable ASCII, or `null` when the run wrote none. A successful run always has an archive, and when `latestRun` succeeded it is the same run as `latestSuccess`.

The run record after a failed run that followed a successful one, `~/.fleet/backup-runs/notes.json`:

```json
{
  "schemaVersion": 1,
  "name": "notes",
  "latestRun": {
    "startedAt": "2026-10-08T19:15:00Z",
    "finishedAt": "2026-10-08T19:15:01Z",
    "exitStatus": 1,
    "archive": null
  },
  "latestSuccess": {
    "startedAt": "2026-10-08T07:15:00Z",
    "finishedAt": "2026-10-08T07:15:04Z",
    "exitStatus": 0,
    "archive": { "name": "2026-10-08T071500Z.sqlite", "sizeBytes": 5242880 }
  }
}
```

### Unreadable records and unknown fields

A record is unreadable when it fails its schema or claims a `schemaVersion` the Collector does not know, and the Collector reports it as unreadable. Heimdall also refuses these, which the JSON Schemas cannot express:

- A health URL whose port is above 65535.
- A run that finished before it started.
- A successful `latestRun` that is not the same run as `latestSuccess`.

The Collector drops fields it does not know and reads the rest of the record. Each System's Collector upgrades on its own schedule, so a record from a newer Fleet stays readable. The JSON Schemas refuse unknown fields, so validating a record before writing it catches a misspelled field. Fleet may write a new optional field once a Heimdall release defines it, and validates against that release's schema. A rename, a removal, or a change of meaning bumps `schemaVersion`, so every Collector is upgraded before Fleet writes the new version. A new `kind` or `supervisor` value is a change of meaning, because a Collector cannot check what it does not know how to read.

## Open Fleet-side asks

These are the gaps between Heimdall's needs and what Fleet's documents and renderer show today. Each is an ask in Fleet's `docs/specs/heimdall-asks.md`; A5 to A7 follow ADR-0010.

- **Darwin user agents (A4).** Native Service Units must run on a macOS System, so that `fleet service heimdall-collector <system> install` runs the Collector's launchd install and reports its status. Until then an operator runs `service install` by hand.
- **An account on a System without one (A4).** A System that declares no `package_user` has no unprivileged account to run the Collector as a systemd user service. It joins Heimdall when Fleet gives it one.
- **Publish the Inventory (A5, M3).** Each Fleet command that changes a System reads the stored commit with `heimdall-hub inventory current` over SSH on the System that hosts the Hub, checks that its own commit descends from it (skipped when the Hub stores `none`), then runs `heimdall-hub inventory publish --expect-commit <stored commit or none>` with the whole-fleet Inventory on standard input ([ADR-0010](decisions/0010-fleet-publishes-inventory-collectors-read-install-records.md)).
- **Install records (A6, M3).** Each Fleet command that installs or updates an Application, Service Unit, or Backup Job writes its install record under `~/.fleet/installed/`, and removing the installed thing removes the record ([Install records and run records](#install-records-and-run-records)).
- **Run records (A7, M3).** Each Backup Job's runner writes its run record to `~/.fleet/backup-runs/<name>.json` after every run, holding its latest run and its latest successful run.
- **Automated pairing (optional, later).** Fleet could run `heimdall-hub pair <system>` and `heimdall-collector pair <code>` for a System that is not paired. Fleet has no cross-System imperative step today, and a System pairs only once, so the manual step stands until the effort pays.

Ask A3, per-System secrets and plain values in one template, is no longer needed. Pairing replaced the per-System token and System name, and the Hub's `port` and `tailnet_port` stay literals on the one System that hosts the Hub.
