### Added

- **`heimdall-collector record` and `forget`** (HMD-53). A provisioner pipes a JSON record of an Application, Service, job, or set of files to `heimdall-collector record <kind>`, and a job's run to `record run <job>`. The Collector validates each, refuses fields it does not know, and keeps them in its state directory; `forget <kind> <name>` removes one.
- **Run history pruning.** The Collector keeps each job's runs for 90 days, and always keeps the latest successful run.
