---
type: adr
title: ADR-0006 - Releases ship both binaries per platform, installed by one script each
description: "A tagged release publishes the Collector and Hub binaries for every platform with SHA256SUMS; Fleet installs and updates each through its own install script, and reads the release from the second word of the version line."
status: accepted
created: 2026-10-06
modified: 2026-10-06
---

# Releases ship both binaries per platform, installed by one script each

## Context

Fleet installs Heimdall as two Applications from one repository: `heimdall` (the Hub, on one System) and `heimdall-collector` (every System).
Fleet does not download release assets itself. Each Application names an install script by URL at the selected tag, which Fleet pipes into `sh` with one version variable set, and an update command that takes the version.
Fleet decides whether a System is current by comparing the Application's version command output with the tag, ignoring a leading `v`.

## Decision

- A `vX.Y.Z` tag publishes one GitHub Release carrying `heimdall-collector-<os>-<arch>` and `heimdall-hub-<os>-<arch>` for darwin-arm64, linux-x64, and linux-arm64, each built on its native runner, plus `SHA256SUMS` and notes compiled from `CHANGELOG.md`. A tag with a hyphen publishes a prerelease, whose notes are the fragments still pending for the release it leads up to.
- The tag must equal the version in `packages/collector/package.json` and `packages/hub/package.json`, which carry one shared version. Each binary embeds that version, so no build-time stamp exists to drift from it.
- `install-collector.sh` and `install-hub.sh` at the repository root each install one binary into `~/.local/bin`, pinned by `HEIMDALL_VERSION`, and refuse a download that `SHA256SUMS` does not vouch for. The two scripts are identical except for the binary name, and a test holds them so.
- The binaries have no `self-update` command. Fleet updates an Application by running its install script again at the new tag.
- The version line is `<binary> v<version> (Report schema v<n>)`, Loom's standard form plus a postfix. Fleet's version command prints its second word.
- Releases are cut by hand with `packages/release`, the release tooling. No automation tags prereleases from `main`.

## Considered options

- One install script for both binaries. Rejected: Fleet passes the script only its version variable, so the script cannot learn which Application it installs. Installing both binaries everywhere would put an unused Hub on every System.
- A `self-update` command in each binary, as Mimir has. Rejected: it puts download and verification logic in the binaries, a second install path that would need its own checks.
- Mimir's automatic `-next` prerelease on every merge. Deferred until Heimdall changes often enough that every System tracking `main` is worth the extra workflows. Adding it later changes nothing above.

## Consequences

Renaming an asset, a script, or `HEIMDALL_VERSION`, or changing the position of the version in the line, breaks Fleet's Application declarations and needs a matching Fleet change.
