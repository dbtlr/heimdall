### Fixed

- **`heimdall-hub serve` on a port in use says which address it could not listen on** (HMD-89). It logs `Could not listen on <host>:<port>: <cause>` as a fatal line and exits 1, as the dashboard does, where a release build showed only "Something went wrong." while systemd restarted the unit.
