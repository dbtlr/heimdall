### Added

- **Collectors pair with the Hub** (HMD-28). `heimdall-collector pair <code>` redeems a Pairing code from `heimdall-hub pair <system>` and keeps the System's name and token in `identity.json` in the state directory, readable by its owner alone, bound to the origin of the Hub that issued them. `run` reports as that System, refuses to start until it is paired, and refuses to send its token to a Hub of another origin, so moving to a new Hub means pairing again. `heimdall-collector service status` names the paired System and its Hub, flags a configured Hub of another origin, or says it is not paired. See [ADR-0009](docs/decisions/0009-collectors-pair-with-the-hub.md).

### Removed

- **The Collector's `--system` and `--token` options** (HMD-28), with `HEIMDALL_SYSTEM`, `HEIMDALL_TOKEN`, and the `system` and `token` keys in `collector.toml`. `collector.toml` holds only `hub` and an optional `stateDir`, the same on every System. Existing installs pair each System once; `run` ignores the old keys, which can be deleted.
