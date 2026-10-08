# Heimdall

Fleet observability: a Collector on each Fleet System Pushes Reports to a Hub, which stores them in PostgreSQL and serves a dashboard of every System's Vitals, managed Services and Backup Jobs, and drift from what Fleet declared. The vocabulary lives in [docs/glossary.md](docs/glossary.md). Heimdall borrows Fleet's terms (System, Service, Push, Drift, and others) unchanged.

## Where things are decided

- [docs/decisions/](docs/decisions/): settled decisions. Anything that contradicts an ADR needs Drew's explicit agreement.
- [docs/roadmap.md](docs/roadmap.md): milestones, v1 scope, and what is deliberately out of it.

## Boundaries

- The Inventory Fleet publishes to the Hub and each System's `manifest.json` are the only sources of desired state. The Hub never reads the Fleet repository, and the Collector never takes instructions from the Hub: its desired-state inputs are `manifest.json` and Fleet's install and run records.
- The Collector never stores command-line arguments, environment variables, or transcript content.
- Fleet installs and operates Heimdall. Packaging, service, and database changes on the Fleet side land in the Fleet repository.
