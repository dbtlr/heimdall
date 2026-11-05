---
description: "How to cut a Heimdall release, what a release publishes, and where Fleet's declarations that install and update the Collector, the Hub, and the dashboard live."
---

# Releasing

A release publishes the Collector, Hub, and dashboard binaries for darwin-arm64, linux-x64, and linux-arm64 on a GitHub Release, with `SHA256SUMS` and notes from [`CHANGELOG.md`](../CHANGELOG.md). [ADR-0006](decisions/0006-releases-ship-both-binaries-installed-by-script.md) records why releases take this shape.

## Changelog fragments

Each pull request that changes what ships adds a fragment in [`.changes/`](../.changes/README.md) instead of editing `CHANGELOG.md`. The fragment's name sets its kind: `breaking.<slug>.md`, `feature.<slug>.md`, or `<slug>.md` for a fix. The changelog guard fails a pull request without one, unless it is a release cut or carries the `skip-changelog` label. The label is for a change with no entry due, such as a refactor, tests, CI, or a dependency update; Dependabot applies it. The guard also runs `loom changelog check` on the pending fragments. Check them locally:

```sh
bun run --cwd packages/collector loom changelog check
```

`loom changelog` runs from the Collector's package directory. Its `loom.config.json` points Loom at the repository's `.changes/` and `CHANGELOG.md` and lists the Hub's and dashboard's `package.json` files as sharing the Collector's version, so one cut versions all three.

## Cut a release

1. On a branch from an up-to-date `main`, preview the cut, then write it:

   ```sh
   bun run release:cut --dry-run
   bun run release:cut
   ```

   Without `--target`, Loom takes the next version from the highest kind among the pending fragments: a breaking fragment raises the minor version while Heimdall is pre-1.0, a feature or fix raises the patch. To choose the version, pass `--target 0.2.0`; it must rank above the current version and meet the version the fragments call for. `--date YYYY-MM-DD` sets the release date, which defaults to today in UTC.

   The cut writes the `## v0.2.0` section into `CHANGELOG.md`, with Breaking Changes, Features, and Fixes groups, deletes the compiled fragments, and sets the version of the Collector, the Hub, and the dashboard in their `package.json` files. The script then refreshes `bun.lock`. Loom refuses to cut, and changes nothing, when a fragment is invalid, when no fragment is pending, or when `CHANGELOG.md` already holds the version. The cut needs full git history, because Loom orders entries by the commit that added each fragment.

2. Open a pull request with the result and merge it once CI passes.

3. Tag the cut's merge commit, not whatever `main` holds by then, and push the tag:

   ```sh
   git fetch origin
   git tag v0.2.0 "$(gh pr view <cut PR number> --json mergeCommit --jq .mergeCommit.oid)"
   git push origin v0.2.0
   ```

The release workflow then:

1. Checks that the tag matches the packaged version.
2. Builds the dashboard app, then compiles the three binaries and tests them on each platform.
3. Publishes the release as a draft, uploads the binaries and `SHA256SUMS`, and verifies the uploads.
4. Makes the release public.
5. Installs each binary through its install script on every platform. This runs once the release is public, so a failure reports a broken release rather than stopping it.

A failed publish leaves a draft that a re-run of the workflow resumes.

## Cut a prerelease

A tag with a hyphen, such as `v0.2.0-rc.1`, publishes a prerelease, which Fleet's stable channel skips. Cut it with `bun run release:cut --target 0.2.0-rc.1`. For a prerelease, the cut sets the version only: it writes no section, and the fragments stay pending. The release workflow takes the prerelease's notes from those pending fragments with `loom changelog notes`. A later prerelease must rank above the one before it. The release that follows is a plain `bun run release:cut`, which finalizes `0.2.0` from the prerelease, writes its `CHANGELOG.md` section, and consumes the same fragments. When a fragment that landed after the prerelease calls for a higher version, the cut names it and asks for `--target`.

## Install a binary

```sh
curl -fsSL https://raw.githubusercontent.com/dbtlr/heimdall/v0.2.0/install-collector.sh \
  | HEIMDALL_VERSION=v0.2.0 sh
```

`install-hub.sh` installs the Hub and `install-dashboard.sh` installs the dashboard the same way. Each script installs into `~/.local/bin`, or into `HEIMDALL_INSTALL_DIR` when set. Without `HEIMDALL_VERSION`, it installs the latest release. It refuses a binary whose checksum `SHA256SUMS` does not list or does not match, and a binary that does not run on the System, and in both cases keeps the binary already installed.

## Fleet's declarations

Fleet's Application declarations for the three binaries, their config templates, and their native Services are in [How Fleet declares Heimdall](fleet.md).
