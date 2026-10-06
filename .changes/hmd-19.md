### Added

- **The Hub answers /api/health** (HMD-19). `GET /api/health` needs no token and returns `200` with `{"database":"ok","version":"<version>"}` when the database answers, or `503` with `{"database":"not answering","version":"<version>"}` when it fails or takes more than 2 seconds. Fleet's Service health check polls it.
