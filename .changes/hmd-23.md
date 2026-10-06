### Added

- **The Hub prunes old Vitals** (HMD-23). While `heimdall-hub serve` runs, about once an hour it deletes raw Vitals samples older than 14 days and rollups older than a year, so retention needs no separate unit. A failed prune logs one warning and the next hour tries again.
