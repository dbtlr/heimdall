### Added

- **Service down covers launchd Services that stay stopped** (HMD-59). The Collector asks `/bin/launchctl print` about every recorded `launchd` Service each minute, in the `gui/<uid>` domain of the account it runs as and then in the `system` domain. A label with a running process is up. A label that is loaded with no running process, or loaded in neither domain, is stopped, and any Hub raises Service down once it has been stopped for 2 minutes of the System's awake time. A `launchctl` that fails to answer, times out, or is missing leaves the check unknown, so the Condition stays as it is. A Collector without this change reports launchd Services as unchecked, so no Hub raises anything for them. A `launchd` Service record is for an agent or daemon that is meant to stay running (`KeepAlive`): one that launchd starts on demand or on a schedule is idle by design, reads as stopped, and raises Service down. See [Service down](docs/spec.md#service-down).
- **`record` refuses a launchd `service` record whose `label` contains a `/`**, since `launchctl print` reads the label as part of `<domain>/<label>`.
- **Service check details are cleaned.** The Collector takes control characters out of every Service check's detail and cuts it to 200 characters without splitting a surrogate pair.

### Changed

- **`service status` reads a launchd agent as not loaded only when `launchctl print` exits 113 and says it could not find the service**, so any other `print` failure reads as state unknown. It also reads an agent with a pid as running, whatever state launchd names.
