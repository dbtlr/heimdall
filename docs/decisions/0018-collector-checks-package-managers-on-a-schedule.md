---
type: adr
title: ADR-0018 - The Collector checks package managers on a schedule
description: "The Collector observes pending package and operating-system updates on an occasional local schedule. M7 starts with existing local metadata, reports unavailable coverage honestly, and leaves room to revisit metadata refresh separately from installing updates."
status: accepted
created: 2026-10-16
modified: 2026-10-16
---

# The Collector checks package managers on a schedule

## Context

[M7](../roadmap.md#m7-system-health) adds pending-update and reboot-required Conditions.
Package managers know about available updates independently of what a provisioner records.
Making each provisioner report that information would duplicate operating-system checks and omit software outside its records.

Running package managers has costs and side effects that reading Vitals does not.
A query can refresh metadata, need a different account, or take long enough to delay other observations.
The Collector needs an explicit execution boundary before those checks are implemented.

## Decision

**The Collector observes pending updates independently of provisioner records.**
The initial checks cover APT, Homebrew, macOS Software Update, and the Debian-family reboot-required marker where supported.
Observations identify the manager, package or update, installed and available versions when known, and security status when the manager establishes it.
Unknown versions or security status remain unknown.
A pending macOS update that would require a restart is distinct from a System already requiring a reboot.

These observations do not compare an Application record with installed software or a provisioner's release channel.
Provisioners continue to compare their declarations with records under [ADR-0011](0011-collectors-hold-what-provisioners-record.md).
The Collector continues to report Application records as recorded.

**M7 starts with existing local metadata.**
Checks query what the System already knows, with automatic metadata refresh and telemetry disabled.
The initial implementation does not run `apt update`, `brew update`, or a macOS scan that contacts Apple.
A missing cache or an unverified cache-only query produces unavailable coverage, with no automatic fallback to a network scan.
In particular, macOS coverage remains unavailable until a supported cache-only query is verified.

Cache-only checks are the starting operational policy, not a permanent architectural prohibition on metadata refresh.
Revisit this policy if stale caches or unavailable coverage make update observations inadequate.
A later decision can permit bounded metadata refresh, accounting for network use, privileges, and resource cost.
Installing or upgrading software, changing package-manager settings, and rebooting remain outside the Collector's observation role.

**Checks run on an occasional local schedule, independently of Vitals and Report delivery.**
Collector configuration owns their settings, following [ADR-0007](0007-binaries-own-their-service-config-file-holds-settings.md).
Runs do not overlap, and waking from sleep does not replay missed checks.
Commands use explicit executables and arguments, with bounded runtime and output, and stop with the Collector.
A slow or failed check cannot block other observations.
The Hub cannot request a command or trigger a check.

**Homebrew checks respect the account that owns the installation.**
Running Homebrew as the Collector's account is not assumed to work when another account owns it.
The Collector neither changes ownership nor attempts interactive authentication or automatic privilege escalation.
Until a supported execution arrangement exists, it reports that installation's coverage as unavailable.
macOS queries also need bounded execution even when they only read cached metadata.

**Reports distinguish successful observations from missing evidence.**
Each check carries its observation time and coverage, including failures, missing tools, and account restrictions.
Only a successful check with usable metadata can report an empty update list or an explicit absence of a reboot requirement.
Repeating a cached observation preserves its time, and a recent query does not make old package metadata current.
Metadata freshness is reported when known and remains unknown otherwise.
Failed, unsupported, or stale evidence cannot clear an open update Condition or lower its level.
The Hub derives Conditions and their levels under [ADR-0017](0017-the-hub-sets-condition-levels.md).

## Considered options

- **Provisioners record pending operating-system updates.** Rejected: the operating system owns this information, independently of any provisioner's Applications.
- **Refresh metadata on every check.** Not chosen for the initial implementation: observation would add network work and package-manager side effects. Revisit if cache-only coverage proves inadequate.
- **Run package managers with every Report.** Rejected: expensive or blocked commands would tie update discovery to the Vitals and delivery cadence.
- **Treat a failed check as no pending updates.** Rejected: an account restriction, missing cache, or timeout would look like recovery.

## Consequences

Update observations are limited by the metadata already present on each System.
Cache maintenance remains outside the initial Collector checks, so a quiet update list is not proof that a System is current.
Some Systems may initially have no usable macOS or Homebrew coverage.

HMD-118 implements this contract and fixes the exact cadence, configuration, command and parser choices, separate-account execution arrangement, and freshness rules.
It also defines the additive Report section and update Condition identities and age thresholds.
Those runtime interfaces are not implemented by this ADR.
