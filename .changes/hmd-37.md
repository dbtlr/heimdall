### Added

- **The Hub shows each job's latest run and latest success** (HMD-37). Collectors send them in Reports when they start, when a `record run` or `forget` changes them, and hourly, without resending the record set. `GET /api/v1/records` returns them for each System beside its records.
- **The Hub knows each System's time zone**, since jobs' schedules are in local time. Every Report names the zone `/etc/localtime` names, read afresh so a change of zone shows at once. `GET /api/v1/records` returns it.
