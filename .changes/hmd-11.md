### Added

- **Releases for every platform** (HMD-11). A tagged release publishes the Collector and Hub binaries for darwin-arm64, linux-x64, and linux-arm64 with `SHA256SUMS` and notes. `install-collector.sh` and `install-hub.sh` install a verified binary at a pinned release, which is how Fleet installs and updates Heimdall. See [Releasing](docs/releasing.md).

### Changed

- **Version line names the release with a `v`** (HMD-11). `--version` prints `heimdall-collector v0.1.0 (Report schema v1)`, Loom's standard form, and the Hub prints the same.
