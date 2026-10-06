---
description: "How to cut a Heimdall release, what a release publishes, and how Fleet's Application declarations install and update the Collector and the Hub."
---

# Releasing

A release publishes the Collector and Hub binaries for darwin-arm64, linux-x64, and linux-arm64 on a GitHub Release, with `SHA256SUMS` and notes from [`CHANGELOG.md`](../CHANGELOG.md). [ADR-0006](decisions/0006-releases-ship-both-binaries-installed-by-script.md) records why releases take this shape.

## Changelog fragments

Each pull request that changes what ships adds a fragment in [`.changes/`](../.changes/README.md) instead of editing `CHANGELOG.md`. The changelog guard fails a pull request without one, unless it carries the `skip-changelog` label. Check fragments locally:

```sh
bun run release changelog check
```

## Cut a release

1. On a branch from an up-to-date `main`, compile the pending fragments:

   ```sh
   bun run release changelog write --version 0.2.0
   ```

   This writes the `## v0.2.0` section into `CHANGELOG.md`, deletes the compiled fragments, and sets the version of the Collector and the Hub in their `package.json` files and in `bun.lock`. It refuses to run when a fragment fails to parse, when no fragment is pending, or when `CHANGELOG.md` already holds the version.

2. Open a pull request with the result and merge it once CI passes.

3. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

The release workflow then:

1. Checks that the tag matches the packaged version.
2. Builds and tests on each platform.
3. Publishes the release as a draft, uploads the binaries and `SHA256SUMS`, and verifies the uploads.
4. Makes the release public.
5. Installs each binary through its install script on every platform.

A failed publish leaves a draft that a re-run of the workflow resumes. A tag with a hyphen, such as `v0.2.0-rc.1`, publishes a prerelease. Run `changelog write` with that version as usual.

## Install a binary

```sh
curl -fsSL https://raw.githubusercontent.com/dbtlr/heimdall/v0.2.0/install-collector.sh \
  | HEIMDALL_VERSION=v0.2.0 sh
```

`install-hub.sh` installs the Hub the same way. Each script installs into `~/.local/bin`, or into `HEIMDALL_INSTALL_DIR` when set. Without `HEIMDALL_VERSION`, it installs the latest release. It refuses a binary whose checksum `SHA256SUMS` does not list or does not match.

## Fleet's Application declarations

Fleet declares each binary as an Application in the Fleet repository. The Collector's declaration looks like this. The Hub's differs in its name, targets, and script.

```toml
[release]
repository = "dbtlr/heimdall"
default_channel = "stable"

[install]
script_url = "https://raw.githubusercontent.com/dbtlr/heimdall/{version}/install-collector.sh"
version_env = "HEIMDALL_VERSION"

[version]
command = ["sh", "-c", "\"$HOME/.local/bin/heimdall-collector\" --version | awk '{ print $2 }'"]

[update]
command = ["sh", "-c", "curl -fsSL \"https://raw.githubusercontent.com/dbtlr/heimdall/$0/install-collector.sh\" | HEIMDALL_VERSION=\"$0\" sh"]
version_args = ["{version}"]
```

The version line is `heimdall-collector v0.2.0 (Report schema v1)`. The version command prints its second word, and Fleet ignores the leading `v` when it compares that word with the tag.
