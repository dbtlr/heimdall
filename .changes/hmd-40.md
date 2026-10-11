### Added

- **Collector reports which Harnesses are installed and their versions** (HMD-40). The Collector reads install directories and package metadata to find Claude Code and Codex, and never runs either. The Hub shows the latest list for each System in a Harnesses column; upgrade the Hub, which applies migration 13, before the Collectors. [The spec](docs/spec.md#installed-harnesses) lists where each version is read.
