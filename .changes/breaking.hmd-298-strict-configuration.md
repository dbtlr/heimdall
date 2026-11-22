- **A mistyped configuration key stops the binary** (HMD-298). A key that `hub.toml`, `collector.toml`, or `dashboard.toml` does not declare, a value its schema rejects, or a file that is not valid TOML now stops the Hub, Collector, or dashboard with exit code 2 and a message that names the key or the line, in every command, instead of running on the default or, for an unparseable file, with a warning and no file. A value only an option refuses, such as `port = "eighty"`, stops every command that takes that option. A Service whose file holds one does not start until the file is corrected, and `service status` exits 2 instead of 0, so Fleet stops on that System with the key named.

### Migration

**Affected surface.** A `hub.toml`, `collector.toml`, or `dashboard.toml` that holds a key the binary does not declare, such as a misspelling or a key from an older release, a value of the wrong type or one an option refuses, or a file that is not valid TOML. A binary also exits 2 on a key a newer Heimdall adds, so a provisioner must not render a new key before the binary that declares it is installed.

**Why.** A mistyped setting used to be dropped silently, so the binary ran on a default the operator never chose.

**Before and after.**

```text
heimdall-collector service status    # before: exit 0, state_dir ignored
heimdall-collector: Unknown key state_dir in .config/heimdall/collector.toml. Check its spelling, or remove it.
                                     # after: exit 2
```

**Steps.**

1. After updating, run `service status` for each binary on each System.
2. Where it exits 2, correct or remove the key it names, in the provisioner's template when a provisioner renders the file.

**Validation.** `service status` exits 0 for each binary, which shows the config file passes every check `serve` and `run` apply, and each Service starts.
