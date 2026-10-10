### Added

- **The Hub mirrors each System's records** (HMD-54). Collectors send their whole record set in Reports when they start, when a `record` or `forget` changes it, and hourly. The Hub keeps each System's latest set, so a forgotten record leaves the mirror.
- **`GET /api/v1/records`** returns every System's mirrored records as JSON, with the same trust as the dashboard, so a provisioner can compare them with what it declares. See [Reading the records back](docs/spec.md#reading-the-records-back).

### Changed

- **The Hub accepts Reports of up to 12 MiB**, up from 4 MiB, to fit a record set beside a full batch of samples. Upgrade the Hub before its Collectors.

### Fixed

- **A System's clock running ahead no longer freezes its transcripts section on the Hub** (HMD-54). The Hub replaces a held section that claims a time later than its own clock, so the next correct Report updates it.
