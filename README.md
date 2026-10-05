# Heimdall

Observability for a small personal fleet. A Collector on each machine reports host vitals, agent sessions, and the state of everything Fleet manages to a Hub on Asgard, which serves a dashboard inside the tailnet.

Status: planning. See [docs/roadmap.md](docs/roadmap.md).

## Development

Heimdall is a Bun workspace with three packages: `packages/schema` (the Report wire schema), `packages/collector`, and `packages/hub`. Tool versions are pinned in `mise.toml`.

```sh
mise install
bun install
bun run verify           # format, lint, typecheck (vp check), then bun test
bun run fix              # apply formatting and lint fixes
bun run build:collector  # compile dist/heimdall-collector for this platform
```
