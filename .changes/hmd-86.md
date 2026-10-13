### Changed

- **The dashboard serves `GET /api/v1/records`, and the Hub no longer does** (HMD-86). The answer is unchanged, `?unpaired=include` and its 400s included, but it is served at the dashboard's address, and the Hub answers 404. A provisioner that reads the records points at the dashboard when it upgrades the Hub; Fleet's doctor takes the address with `--hub`. See [Reading the records back](docs/spec.md#reading-the-records-back).

### Fixed

- **The dashboard's API routes answer 405 to any method but GET and HEAD** (HMD-86). `POST /api/health` and the like rendered the dashboard's page with 200.
