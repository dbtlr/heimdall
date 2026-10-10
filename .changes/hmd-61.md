### Added

- **The Hub raises Service down for a Service whose health URL stops answering** (HMD-61). The Collector requests the `health` URL of each recorded Service every minute, on loopback only, without following redirects and ignoring any proxy setting in its environment, and reports it as a `health` check beside the supervisor check in the `services` part of the `checks` section. A 2xx or 3xx status is up. Any other status, a refused or reset connection, an answer that is not valid HTTP, or no answer in 5 seconds is unhealthy. The Hub raises the Service's one Service down Condition once a check has failed for 2 minutes of the System's awake time, with the reason `Unhealthy: <detail>.` (a stopped supervisor still says `Stopped: <detail>.`), and clears it when every check passes. A health URL that has failed for 2 minutes raises it even while the supervisor check is unknown, since the failure is direct evidence; an unknown check alone still leaves the Condition as it is. A `none` Service with a `health` URL is checked by the URL alone; one without is still listed and unchecked. See [Service down](docs/spec.md#service-down).
- **`GET /api/v1/records` returns health checks** in `checks.services`, with `check` `health` and `state` `unhealthy`. A Hub with this change accepts Reports from Collectors without it, and leaves what it holds unchanged.

### Fixed

- **`service status` asks the Hub for its health directly**, ignoring any proxy setting in the environment (`HTTP_PROXY`, `http_proxy`), so the request reaches the address the Hub listens on instead of the proxy.
