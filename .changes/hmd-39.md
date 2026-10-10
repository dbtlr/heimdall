### Added

- **The Hub raises job failing and job overdue Conditions** (HMD-39). A job whose latest run failed is failing. A job is overdue when its System was awake for its grace period after a scheduled time with no successful run since, so a laptop asleep through a scheduled time is not overdue until it has been awake that long. The page and the Timeline name the job. See [Job Conditions](docs/spec.md#job-conditions).
- **A job record may set `graceMinutes`**, from 1 to 10,080, the awake time the Hub waits after a scheduled time before it raises job overdue. It is 60 when left out. Upgrade the Hub, then the Collectors, before a provisioner sends it.
