### Changed

- **Collector and Hub read their configuration from ~/.config/heimdall/** (HMD-18). The Collector looks for `.config/heimdall/collector.toml` or `.json`, and the Hub for `.config/heimdall/hub.toml` or `.json`, in the working directory and then the home directory. This is where Fleet renders the files. Move an existing `~/.heimdall-collector.toml` or `~/.heimdall-hub.toml` to the new path, because the old names are no longer read.
