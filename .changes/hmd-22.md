### Added

- **The Hub rolls Vitals up into 5-minute buckets** (HMD-22). Each stored sample updates its System's UTC-aligned 5-minute bucket in the same transaction, keeping count, min, sum, and max of CPU busy, memory used, and 1-minute load, plus the largest memory total, the smallest uptime, the Collector's footprint, and each disk's largest used and total. Resent samples never count twice, late samples land in their own bucket, and upgrading backfills the buckets from the samples already stored.
