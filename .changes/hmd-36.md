### Added

- **The Hub raises Service down for systemd and systemd-user Services that stay stopped** (HMD-36). The Collector asks `systemctl` about every recorded `systemd` and `systemd-user` Service each minute and reports each check's state, a short detail, and since when in a new `services` part of the `checks` section; a Service whose supervisor it does not check yet, such as launchd or docker, is reported as unchecked, never as down. The Hub raises one Service down Condition per Service once a check has been stopped for 2 minutes of the System's awake time, counted from its Vitals like job overdue so that neither the System's clock nor time spent silent or asleep counts, and clears it when the check passes or the Service is forgotten. A check the Collector could not make, such as when the account has no user bus, leaves the Condition as it is. See [Service down](docs/spec.md#service-down).
- **`GET /api/v1/records` returns each System's Service checks** in `checks.services`. A Hub with this change accepts Reports from Collectors without it, and leaves open Service down Conditions as they are for such a System. Upgrade the Hub, then the Collectors.
- **Each part of the `checks` section has its own budget.** The Collector sends a part over 1 MiB as its size in `overBudget`, named for the part, and the other parts as they are, so a large files part cannot freeze Service down. `GET /api/v1/records` names such a part in `checks.overBudget` and leaves its entries out.

### Changed

- **The checks section's over-budget form is per part.** HMD-35's `overBudget: {bytes}` for the whole section is now `overBudget: {files: {bytes}}` or `{services: {bytes}}`, which no released Collector sent, since HMD-35 and HMD-36 ship together.
- **A systemd or systemd-user `service` record refuses a `unit` that `systemctl` would read as a pattern or a job id**: one with `*`, `?`, or `[`, or made only of digits. The record contract is unreleased, so this tightens it before any provisioner relies on it.
- **`GET /api/v1/records` leaves `files` and `fileRecords` out of `checks` when the Collector has sent no files part yet**, so a provisioner can tell checks that judged nothing from a files part that lists nothing. Drift is unchanged.
- **The Collector's `mount` and `vm_stat` commands for Vitals now also time out after 5 seconds**, as the `systemctl` checks do.
