---
description: "How to write the changelog fragment a pull request adds instead of editing CHANGELOG.md."
---

# Changelog fragments

Pending changelog entries, one file per change. The release cut compiles them into the new section of [`CHANGELOG.md`](../CHANGELOG.md) and deletes them in the same commit. [Releasing](../docs/releasing.md) describes the cut. Loom's `loom changelog` owns the grammar, which [its changelog reference](https://github.com/dbtlr/loomcli/blob/main/docs/toolchain/changelog.md) documents in full.

## Name the fragment

- `breaking.<slug>.md` is a breaking change, `feature.<slug>.md` a feature, and `<slug>.md` a fix.
- Use a unique slug that starts with the task id, such as `feature.hmd-11-disk-pressure.md`. Use letters, digits, dots, dashes, and underscores. A bare `feature.md` or `breaking.md` is invalid.
- Keep fragments directly in `.changes/`. This `README.md` is not a fragment.

## Write the entry

Markdown bullets, with no frontmatter and no headings. Indent continuation lines. Write each bullet as it will appear in the release, and keep links relative to the repository root, such as `docs/releasing.md`, because the entry ends up in `CHANGELOG.md` there.

```markdown
- **Collector reports disk pressure** (HMD-99). One to three sentences on what an operator can now see or do.
```

## Explain a breaking change

A change is breaking when an operator or a provisioner must change a configuration file, a script, or a declaration to update. After the bullets, add one `### Migration` section holding each of the labels `**Affected surface.**`, `**Why.**`, `**Before and after.**`, `**Steps.**`, and `**Validation.**` once:

````markdown
- **The Collector drops the `--out` option** (HMD-98). Use `--output`.

### Migration

**Affected surface.** Scripts that pass `--out`.

**Why.** Every other command spells it `--output`.

**Before and after.**

```sh
heimdall-collector export --out report.json
heimdall-collector export --output report.json
```

**Steps.**

1. Replace `--out` with `--output` in each script.

**Validation.** Run each script and check that it writes its file.
````

## Check

`bun run --cwd packages/collector loom changelog check` validates every fragment. The changelog guard runs the same check on every pull request. A pull request that changes what ships needs a fragment unless it is a release cut or carries the `skip-changelog` label, which is for a change with no entry due: a refactor, tests, CI, or a dependency update.
