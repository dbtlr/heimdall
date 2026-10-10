### Added

- **The Hub raises Service down for docker Services whose container stays stopped** (HMD-60). The Collector asks the Docker Engine API over its unix socket, with no `docker` CLI, whether each recorded `docker` Service's container is running: at `DOCKER_HOST` when that is a `unix://` URL, otherwise at `docker.sock` in `XDG_RUNTIME_DIR` or `/run/user/<uid>`, where rootless Docker under the Collector's account keeps it. A running container is up. An exited, created, paused, restarting, dead, or missing container is stopped, and raises Service down after 2 minutes of the System's awake time. An unreachable socket, a timeout, or an unexpected answer leaves the Condition as it is, as does a `DOCKER_HOST` that names another transport. Docker's own healthcheck is not read. A docker Service was reported as unchecked before. See [Service down](docs/spec.md#service-down).

### Changed

- **A docker `service` record's `container` must be a Docker container name or ID**: `record` refuses a `container` that does not start with a letter or digit, holds a character other than letters, digits, `_`, `.`, or `-`, or is longer than 256 characters, since the Collector puts it in the path of an Engine request. The Hub reads a Report's record with a `container` outside this form as unreadable.
