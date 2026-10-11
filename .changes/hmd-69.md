### Added

- **Collector reports Harness processes** (HMD-69). On Linux and macOS the Collector records each Claude Code and Codex root process every 15 seconds in a new `harnessProcesses` Report section: its pid, start, end, working directory, and the CPU time and memory of its process tree, never its command-line arguments or environment. The Hub keeps the processes, closes one the Collector stopped listing as an end it missed, and stores each reading as a sample that rolls up and prunes like Vitals; upgrade the Hub, which applies migration 14, before the Collectors.
