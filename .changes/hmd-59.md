### Added

- **The Hub raises Service down for launchd Services that stay stopped** (HMD-59). The Collector asks `/bin/launchctl print` about every recorded `launchd` Service each minute, in the `gui/<uid>` domain of the account it runs as and then in the `system` domain. A label with a running process is up. A label that is loaded with no running process, or loaded in neither domain, is stopped, and the Hub raises Service down once it has been stopped for 2 minutes of the System's awake time. A `launchctl` that fails to answer, times out, or is missing leaves the check unknown, so the Condition stays as it is. A Collector without this change reports launchd Services as unchecked, so a Hub that has it raises nothing for them. See [Service down](docs/spec.md#service-down).

### Changed

- **A launchd `service` record may not name its `label` with a `/`**: `record` refuses it, since `launchctl print` reads the label as part of `<domain>/<label>`.
