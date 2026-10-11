### Added

- **The Hub derives Claude Code Session insight from the transcripts it holds** (HMD-65). `heimdall-hub serve` parses new transcript content every 15 seconds into Sessions, subagents, requests, and tool calls, counting each response once. A parser version change rebuilds beside the old facts, which stay readable until the rebuild catches up. See [Session insight](docs/spec.md#session-insight).
- **The `insight` views** in the Hub's database read Session insight: Sessions, subagents, requests, tool calls, totals with and without subagents, and parse status. They carry facts and locators into the archive, never transcript content. See [The insight views](docs/spec.md#the-insight-views).
