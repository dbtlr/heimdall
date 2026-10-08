### Added

- **Install record and run record formats for Fleet to write** (HMD-33). `packages/schema/install-record.v1.schema.json` describes the record Fleet leaves under `~/.fleet/installed/` for each Application, Service, and Backup Job it installs, and `packages/schema/run-record.v1.schema.json` describes each Backup Job's record of its latest run and latest success under `~/.fleet/backup-runs/`. `docs/fleet.md` gives the layout, the fields, and how the Collector reads them.
