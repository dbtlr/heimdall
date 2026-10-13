### Fixed

- **Slow dashboard pages keep their HTTP connection** (HMD-95). The dashboard waits 60 seconds before closing an idle connection, allowing its 30-second database statement limit to finish or report an error. The Hub keeps its existing timeout. A delayed page is tested through the real HTTP listener.
