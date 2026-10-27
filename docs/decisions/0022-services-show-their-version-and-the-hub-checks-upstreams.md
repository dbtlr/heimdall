---
type: adr
title: ADR-0022 - Each Service shows its installed version, and the Hub checks its upstream for newer releases
description: "A Docker Service's installed version is the image tag the Collector reads from the container; any other Service takes the version of an Application record it names. An Application's source takes a typed prefix that names its upstream. The Hub checks GitHub, npm, and OCI upstreams on a slow schedule, APT and Homebrew upstreams come from the Collector's package observations, and a newer release on the installed version's channel is an available update: a fact on the Services page, never a Condition."
status: accepted
created: 2026-10-27
modified: 2026-10-27
---

# Each Service shows its installed version, and the Hub checks its upstream for newer releases

## Context

The dashboard shows each System's Services on that System's page, and nothing lists them across the fleet.
A Service record names its supervisor and target, and carries no version.
An Application record carries a version and a free-text `source`, but nothing links an Application to the Service that runs it, and nothing can tell from `source` where newer releases are published.
[ADR-0018](0018-collector-checks-package-managers-on-a-schedule.md) has the Collector observe pending APT and Homebrew updates from local metadata only, which misses software installed from a GitHub release, an npm package, or a container image.

A provisioner already knows what it installed.
Comparing that with what it declares is the provisioner's own check ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)), so a provisioner's next intended version is not what "update available" means here.
It means a newer release exists upstream.

## Decision

**A Service's installed version comes from its container or from the Application it names.**
For a Docker Service, the Collector reads the image reference from the container inspect answer its check already gets, and reports it with the Service's checks.
The image's tag is the installed version, and its repository is the upstream; a digest is shown and never compared.
Any other Service record can name an Application record on the same System, and the Service takes that Application's version and upstream.
When the upstream is an APT or Homebrew package and the Collector's package census holds its installed version, the observed version wins over the recorded one.
A Service with neither shows its version as unknown and never shows an update.

**An Application's `source` names its upstream with a typed prefix.**
The kinds are `github:owner/repo`, `npm:package`, `oci:registry/repository`, `apt:package`, and `brew:formula`.
A `source` without a known prefix is still recorded and shown, and its Service never shows an update.

**The Hub checks GitHub, npm, and OCI upstreams on a slow schedule.**
It queries each distinct upstream at most every few hours: GitHub's releases, the npm registry's versions, or the registry's tag list, anonymously.
It keeps the newest release it found per channel and when it last checked, and a failed check keeps the last answer and records the failure.
APT and Homebrew upstreams are never queried by the Hub; their newer versions come from the Collector's pending-update observations under ADR-0018, with ADR-0018's freshness rules.
The Collector still contacts no upstream.

**An update is a newer release on the installed version's channel.**
Versions compare as semver, with a leading `v` ignored.
A stable installed version compares only with stable releases.
A prerelease, such as `0.26.0-next.32`, compares with stable releases and with prereleases that carry its own label.
Tags and versions that do not read as semver, such as `latest`, are never compared, and the Service shows that its version cannot be compared.

**An available update is a fact, never a Condition.**
The Services page and the Service's page show it, and it changes no level, delivery, or Timeline ([ADR-0017](0017-the-hub-sets-condition-levels.md)).
APT-sourced Services still raise their System's pending-update Condition under ADR-0018, as before.

**The Hub keeps each version a Service runs.**
Each change of a Service's installed version is stored with when the Hub first saw it, from the release that adds this, so a Service's history shows when it changed.

## Consequences

- The Hub makes outbound HTTPS requests to GitHub, npm, and container registries for the first time. An upstream that rate-limits or fails shows when it was last checked.
- A provisioner that wants versions for non-Docker Services records an Application per Service and names it on the Service record.
- A Report gains the image reference additively ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)), and an older Hub drops it.
- A Docker image pinned to a moving tag, such as `latest`, never shows an update.

## Considered options

- **The provisioner records an available version.** Rejected: it stores a provisioner's declaration ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)) and tells what the provisioner would install, not what upstream has.
- **Only package-manager observations.** Rejected: most Services run from GitHub releases, npm packages, or container images, which those observations do not cover.
- **The Service record carries its own version and source.** Rejected: it copies what Application records already hold, and a Docker version would be recorded rather than observed.
- **The Hub guesses the upstream from free-text `source`.** Rejected: `owner/name` reads as a GitHub repository, a container image, or neither.
- **Any newer release, prereleases included.** Rejected: a stable install would show every beta as an update.
- **An update raises a note.** Rejected: upstreams release faster than a personal fleet upgrades, so the Fleet page would carry a standing pile of notes.
