### Fixed

- **The Hub's refresh of stored Session insight drains a backlog without slowing down as it grows** (HMD-99). It picks up to 20 stale Sessions at a time and leaves out only those that failed or another refresh holds, instead of sorting every stale Session again for each one. A backlog of 2,400 Sessions, such as every Session after a price change, drains in 3 seconds instead of 19.
