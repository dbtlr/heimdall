---
description: "How to write the changelog fragment a pull request adds instead of editing CHANGELOG.md."
---

# Changelog fragments

Pending changelog entries, one file per pull request. The release cut compiles them into the new section of [`CHANGELOG.md`](../CHANGELOG.md) and deletes them in the same commit. [Releasing](../docs/releasing.md) describes the cut.

- **File name:** a unique slug ending in `.md`. Use the task id, such as `hmd-11.md`. This `README.md` is not a fragment.
- **Content:** [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) entries exactly as they will appear in the release: `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, or `### Security` headings, each followed by `- ` bullets. Indent continuation lines. Nothing else parses, and fragments have no frontmatter.
- **Links:** relative to the repository root, such as `docs/releasing.md`, because the entry ends up in `CHANGELOG.md` there.

```markdown
### Added

- **Collector reports disk pressure** (HMD-99). One to three sentences on what an operator can now see or do.
```

Check fragments with `bun run release changelog check`. The changelog guard runs the same parser on every fragment a pull request adds or edits. A pull request that changes what ships needs a fragment unless it is a release cut or carries the `skip-changelog` label, which is for a change with no entry due: a refactor, tests, CI, or a dependency update.
