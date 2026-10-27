---
type: adr
title: ADR-0022 - Each Service shows its installed version, and the Hub checks its upstream for newer releases
description: "A Docker Service's installed version is the image tag the Collector reads from the container; any other Service takes the version of an Application record it names. An Application's source takes a typed prefix that names its upstream. The Hub checks GitHub, npm, and OCI upstreams on a slow schedule and joins APT and Homebrew upstreams with the Collector's package observations. A newer release on the installed version's channel is an available update: a fact on the Services page, never a Condition. Service restarted notes are shown on the Services page."
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
A `service` record gains an optional `application` field naming an Application record on the same System.
`record` does not check the name, so a provisioner can record the two in either order.
For a Docker Service, the Collector reads the image reference from the container inspect answer its check already gets, and reports it with the Service's checks.
The reference's tag is the installed version; a reference with no tag, or only a digest or an image ID, gives an unknown version.
A Docker Service that names an Application keeps its image tag as the installed version and takes its upstream from the Application, for software that publishes releases somewhere other than its image's tags.
Any other Service takes the version and upstream of the Application it names.
A Service whose named Application is not recorded, or was forgotten, shows its version as unknown together with the name it gave.
A Service with neither an image nor a named Application shows its version as unknown.

**An Application's `source` names its upstream with a typed prefix.**
The kinds are `github:owner/repo`, `npm:package`, `oci:registry/repository`, `apt:package`, and `brew:name`.
`apt:` names a package without its architecture and matches any architecture; `brew:` names a formula or a cask.
A `source` without a known prefix is still recorded and shown, and its Service never shows an update.
A Docker image's upstream is its repository, normalized with Docker Hub's defaults to `registry/repository`, so `nginx` and `docker.io/library/nginx` are one upstream.
The Hub treats equal upstreams on different Systems as one.

**The Hub checks GitHub, npm, and OCI upstreams on a slow schedule.**
It queries each distinct upstream at most every few hours, without credentials: GitHub's releases, the npm registry's versions, or a registry's tag list after its anonymous token challenge.
It keeps the newest release it found per channel and when it last checked.
A failed check keeps the last answer and records the failure, and a rate-limited answer defers the next check to the reset time it gives.
The Collector contacts no upstream.
The Hub uses HTTPS only and contacts the registry host an `oci:` upstream names, which a paired System's provisioner recorded; under the single-person trust model a paired System is trusted, and limiting which hosts the Hub contacts waits for Hardening, as authentication does.

**The Hub joins APT and Homebrew upstreams with the Collector's package observations.**
The Collector's observations under ADR-0018 are unchanged and still compare nothing with Application records.
The Hub reads the installed and available versions of an `apt:` or `brew:` package from the observations its System reports, under ADR-0018's freshness rules.
An observed installed version wins over the recorded one.
Where that System's coverage is unavailable, as for a Homebrew installation the Collector's account cannot run, the Service shows its recorded version and no update.

**An update is a newer release on the installed version's channel.**
Versions compare as semver read loosely: a leading `v` is ignored, a missing minor or patch reads as 0, and build metadata after `+` is ignored.
A version's label is the first dot-separated identifier after `-`, so `0.26.0-next.32` and `0.26.0-next.35` share the label `next`, and `16-alpine` has the label `alpine`.
A version without a label compares only with releases without one.
A version with a label compares with releases of its own label, and with releases without one whose numbers are greater, so `16-alpine` counts both `16.1-alpine` and `17` as newer but not `16`.
A version that does not read this way, such as `latest`, is never compared, and the Service shows that its version cannot be compared.
A Service shows no update, and is not called up to date, while its upstream has never been checked successfully or its installed version is newer than every release found.

**An available update is a fact, never a Condition.**
The Services page and the Service's page show it, and it changes no level, delivery, or Timeline ([ADR-0017](0017-the-hub-sets-condition-levels.md)).
The pending-update Condition that an APT or Homebrew package raises under ADR-0018 is unchanged.

**The Hub keeps each version a Service runs.**
Each change of a Service's installed version is stored with when the Hub first saw it, from the release that adds this, so a Service's history shows when it changed.
The Hub also keeps when it first found each newer release of an upstream, so a Service's history shows when an update became available; a release found once stays found, whether or not later checks succeed.

**Service restarted notes are shown on the Services page.**
The dashboard lists them with their Services, and leaves them out of a System's open Conditions and the Fleet page's Can wait.
The note itself is unchanged: the Hub raises and clears it under [ADR-0021](0021-the-collector-logs-service-stops-and-the-hub-raises-a-note.md), it leaves its System healthy, and the Timeline and the Condition's own page still show it.
A restart is read beside the Service it happened to, and a fleet that deploys often would otherwise fill Can wait with notes. Service down stays among open Conditions, since it is an alert.

## Consequences

- The Hub makes outbound HTTPS requests to GitHub, npm, and container registries for the first time. An upstream that rate-limits or fails shows when it was last checked.
- A provisioner that wants versions for non-Docker Services records an Application per Service and names it on the Service record.
- A Report gains the image reference additively ([ADR-0004](0004-report-grows-additively-samples-keyed-by-system-and-time.md)), and an older Hub drops it.
- A Docker image pinned to a moving tag, such as `latest`, never shows an update.
- A Docker variant tag, such as `16-alpine`, also counts the plain tag of a newer version as an update.

## Considered options

- **The provisioner records an available version.** Rejected: it stores a provisioner's declaration ([ADR-0011](0011-collectors-hold-what-provisioners-record.md)) and tells what the provisioner would install, not what upstream has.
- **Only package-manager observations.** Rejected: most Services run from GitHub releases, npm packages, or container images, which those observations do not cover.
- **The Service record carries its own version and source.** Rejected: it copies what Application records already hold, and a Docker version would be recorded rather than observed.
- **A separate `upstream` field beside `source`.** Rejected: two fields would hold one fact about where the software comes from.
- **The Hub guesses the upstream from free-text `source`.** Rejected: `owner/name` reads as a GitHub repository, a container image, or neither.
- **Strict semver.** Rejected: most container tags, such as `16` or `16.4`, would never compare.
- **Any newer release, prereleases included.** Rejected: a stable install would show every beta as an update.
- **An update raises a note.** Rejected: upstreams release faster than a personal fleet upgrades, so the Fleet page would carry a standing pile of notes.
