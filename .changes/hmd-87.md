### Fixed

- **`service status` on macOS notes a missing GUI login session** (HMD-87). launchctl answers 112, not 113, for a GUI domain that does not exist, so the "no GUI login session" note never appeared on a real Mac. The launchd tests now run against output captured from macOS.
