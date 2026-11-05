- **A file that does not parse is skipped with a warning** (HMD-206). The binary then runs with no configuration file. A bad value inside a file still stops `serve` and `run` when it is in a section Heimdall checks itself: `[delivery]`, `[conditions]`, `[sessions]`, and `[updates]`. A top-level setting with the wrong type, such as a text `sleeps`, or one its option rejects, such as an `insight_reader` that is not a role name, is dropped and named at `-v`, and the option falls back to its default.
- **A TOML date or time value inside a section Heimdall checks now reaches its checks as text** (HMD-206), so `topic = 2026-01-01` is accepted as the topic "2026-01-01". Loom reads dates that way.

### Migration

**Affected surface.** A configuration file that holds a wrong-typed top-level value or that does not parse.

**Why.** Loom's configuration plugin skips a file it cannot read and drops a value its option rejects, so the binary keeps running on its defaults instead of stopping.

**Before and after.**

```toml
# Before: sleeps = "often" stopped the binary at startup.
# After: the value is dropped, named at -v, and the default applies.
sleeps = "often"
```

**Steps.**

1. Run the binary with `-v`.
2. Fix each value named on an `Ignored` line, and repair a file the binary warns it skipped.

**Validation.** Run the binary again with `-v` and check that no `Ignored` line appears.
