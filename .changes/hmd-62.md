### Added

- **The dashboard's unpaired view and the records read's `unpaired=include`** (HMD-62). When any System is unpaired, the page links to `/?unpaired`, which lists those Systems with an Unpaired status and their Vitals, last seen, and Timeline. `GET /api/v1/records?unpaired=include` lists them too, and every entry in the read now carries `paired`. See [Reading the records back](docs/spec.md#reading-the-records-back).

### Changed

- **`heimdall-hub unpair` now hides the System** from the page's normal view and from `GET /api/v1/records`, which a provisioner's checks read as the paired fleet. Its history is kept, and pairing it again brings it back.
