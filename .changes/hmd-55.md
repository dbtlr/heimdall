### Added

- **The Hub raises stale System and low disk Conditions** (HMD-55). A System the Hub has not heard from, by Report or transcript upload, for more than 10 minutes, or 7 days when it sleeps, is stale; a paired System that never reported counts from its pairing and shows as never seen. A mount below 10% free in a System's latest Vitals sample is low on disk, until it is above 15% free again. A System that is unpaired has both cleared. The page and the Timeline name the mount. See [System Conditions](docs/spec.md#system-conditions).
- **A Collector's `collector.toml` may set `sleeps = true`**, which every Report then carries, for a System such as a laptop that sleeps. It is `false` when left out. Upgrade the Hub, then the Collectors; until a Collector sends `sleeps`, the Hub treats its System as always on.

### Changed

- **The Hub keeps a row for a paired System it has never heard from**, with no last seen, so a Condition can be about it. The page shows it as never seen.
