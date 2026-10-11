# Heimdall

Cheap observability for a personal fleet and the agent work done on it: a Collector on each System pushes Reports to a Hub, which stores them in PostgreSQL, archives agent Session transcripts, and serves a dashboard of every System's Vitals and the Services and jobs its provisioner recorded. Heimdall works with any provisioner. The vocabulary lives in [docs/glossary.md](docs/glossary.md).

## Where things are decided

- [docs/decisions/](docs/decisions/): settled decisions. Anything that contradicts an ADR needs Drew's explicit agreement.
- [docs/roadmap.md](docs/roadmap.md): milestones, v1 scope, and what is deliberately out of it.
- [docs/spec.md](docs/spec.md): the roles and contracts any provisioner follows.

## Boundaries

- Heimdall stores no provisioner's declarations. A provisioner tells a Collector what it installed with `heimdall-collector record`; Heimdall compares those records with what the Collector observes, and the provisioner compares its declarations with the records the Hub mirrors ([ADR-0011](docs/decisions/0011-collectors-hold-what-provisioners-record.md)).
- The Collector never takes instructions from the Hub, and reads no file a provisioner keeps as its own record.
- The Hub archives agent Session transcripts, content included ([ADR-0012](docs/decisions/0012-hub-archives-agent-session-transcripts.md)). From the process table, the Collector records only executable names and working directories, never command-line arguments or environment variables.
- Heimdall depends on no provisioner. Fleet is the provisioner that installs and operates Heimdall today; Fleet-side packaging, service, and database changes land in the Fleet repository.
