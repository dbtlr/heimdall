### Added

- **Session page** (HMD-88). Each Session row on a System's page opens the Session at `/systems/<name>/sessions/<harness>/<source>/<session id>`, under a header with its place, span, and totals, in three tabs that link to each other.
  - **Timeline:** a lane per agent, with request marks by model, over the System's CPU, its Harness processes' cores, and the process link, and an inspector for any request.
  - **Cost:** what the list-price cost paid for by token kind, how it ran up for the main conversation and subagents, and the main conversation's context fill, then the cost by agent, model, skill, and tool.
  - **Trace:** every main-conversation request with its tool calls, with subagents folded, waits, skills, commands, and process links between them.
- **Cost by token kind in `insight.requests`** (HMD-88). `input_cost_usd`, `output_cost_usd`, `cache_read_cost_usd`, and `cache_write_cost_usd` split each priced request's `cost_usd` by the tokens it paid for, as described in [the spec](docs/spec.md#cost).
