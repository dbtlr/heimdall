# Heimdall

Cheap observability for a personal fleet and the agent work done on it: a Collector on each System pushes Reports to a Hub, which stores them in PostgreSQL, and archives agent Session transcripts; a dashboard reads the Hub's database and shows every System's Vitals and the Services and jobs its provisioner recorded. Heimdall works with any provisioner. The vocabulary lives in [docs/glossary.md](docs/glossary.md).

## Where things are decided

- [docs/decisions/](docs/decisions/): settled decisions. Anything that contradicts an ADR needs Drew's explicit agreement.
- [docs/roadmap.md](docs/roadmap.md): milestones, v1 scope, and what is deliberately out of it.
- [docs/spec.md](docs/spec.md): the roles and contracts any provisioner follows.

## Boundaries

- Heimdall stores no provisioner's declarations. A provisioner tells a Collector what it installed with `heimdall-collector record`; Heimdall compares those records with what the Collector observes, and the provisioner compares its declarations with the records the Hub mirrors ([ADR-0011](docs/decisions/0011-collectors-hold-what-provisioners-record.md)).
- The Collector never takes instructions from the Hub, and reads no file a provisioner keeps as its own record.
- The Hub archives agent Session transcripts, content included ([ADR-0012](docs/decisions/0012-hub-archives-agent-session-transcripts.md)). From the process table, the Collector records only executable names and working directories, never command-line arguments or environment variables.
- Heimdall depends on no provisioner. Fleet is the provisioner that installs and operates Heimdall today; Fleet-side packaging, service, and database changes land in the Fleet repository.

## Working here

- The machine agents develop on is a System in the fleet. It runs the live Hub, Collector, and dashboard as user Services (`com.dbtlr.heimdall.hub`, `.collector`, and `.dashboard`), with their real configuration in `~/.config/heimdall/`. A real `service install`, or any write under that directory, changes the production Heimdall. Prove Service behavior with `fakeSupervisor` and `tempHome` from `packages/service/src/testing.ts`. Run a compiled binary with a throwaway `HOME`, and call bun by its resolved path, `$(mise which bun)`, because the mise shim fails under a fake `HOME`.
- No real machine name appears in the repository: not in code, help or error text, test fixtures, docs, commit messages, or PR bodies. System names come only from configuration: the name given to `heimdall-hub pair <system>`, kept in the Hub's token table and the Collector's identity. Docs use role phrases such as "the Hub's System", and fixtures use fictional names such as `laptop-1` and `server-1`.
- Heimdall is a personal tool on a single-person tailnet, not a multi-user production system. Take the direct path over a defensive layer: the dashboard reads the Hub's database as the Hub's role ([ADR-0015](docs/decisions/0015-dashboard-is-its-own-app-reading-the-hubs-database.md)), with no read-only role, contract view, or extra API in between. State minor architecture defaults rather than asking, and ask only when a choice changes product behavior. Security work waits for Hardening, under Later in the [roadmap](docs/roadmap.md).
- Every read is sub-second: a dashboard page, an `insight` view or function, a Hub command. Measure a new read at production scale, on the order of 10,000 Sessions, 100,000 subagents, and 10 million requests, and treat a read that takes a second or more as a defect, not a limitation. Fix it at its cause: first the storage shape (a value stored where it is read, an index the query can use), then the query, and precompute only when those are not enough.
