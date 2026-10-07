### Added

- **Systems pair with the Hub** (HMD-27). `heimdall-hub pair <system>` prints a single-use Pairing code, such as `7K3M-Q9XA`, that expires after 10 minutes, and `POST /api/v1/pair` redeems it for the System's name and a new token. Pairing a paired System again rotates its token, and `heimdall-hub unpair <system>` revokes it and keeps the System's history. Every failed redemption gets the same answer, and the Hub refuses redemptions after 10 failures in a minute. The Collector side, `heimdall-collector pair <code>`, follows in HMD-28. See [ADR-0009](docs/decisions/0009-collectors-pair-with-the-hub.md).

### Changed

- **The Hub authenticates Reports by the tokens in its database** (HMD-27). It keeps only their SHA-256 hashes, so adding or revoking a System needs no restart, and `serve` counts paired Systems as it starts.
- **The Hub reads its database URL from `[database] url`** (HMD-27). Move a top-level `database` key in `hub.toml` into a `[database]` table as `url`. `--database` and `HEIMDALL_DATABASE_URL` are unchanged.

### Removed

- **The Hub's `tokens` setting and `--token` option** (HMD-27). Existing installs pair each System once instead, and the Collectors that used configured tokens stop authenticating until they pair.
