---
description: "The fleet observability spec: the roles in a Heimdall fleet, the principles that divide their work, what a provisioner records with a Collector and what Heimdall checks, how a provisioner reads the records back, and how agent Session transcripts reach the Hub."
---

# Fleet observability spec

A fleet is a person's own set of Systems. Heimdall observes a fleet and the agent work done on it, whatever provisions its Systems. This spec states what each role does and what a provisioner follows to plug in. [ADR-0011](decisions/0011-collectors-hold-what-provisioners-record.md) and [ADR-0012](decisions/0012-hub-archives-agent-session-transcripts.md) record why. Terms are defined in the [glossary](glossary.md).

Roles and Principles describe Heimdall as designed. Sections marked _planned_ describe contracts not built yet, whose exact fields are fixed when the milestone that builds them lands ([roadmap](roadmap.md)).

## Roles

| Role | Runs | Does |
| --- | --- | --- |
| System | everywhere | One machine in the fleet, named by a DNS label. |
| Collector | on each System, as one account | Samples Vitals, observes agent Sessions, holds what provisioners record, checks it, and sends Reports and transcripts to the Hub. |
| Hub | on one System | Stores Reports and transcripts in PostgreSQL, derives Conditions, mirrors each System's records, and serves the dashboard. |
| Provisioner | wherever its operator runs it | Installs things on Systems and records them with each System's Collector. Fleet is one provisioner; [Running Heimdall with Fleet](fleet.md) shows how it does this. |

A System joins by pairing its Collector with the Hub once, as the [README](../README.md#pairing-a-new-system) describes.

## Principles

1. **The Collector holds what is on its System.** A provisioner tells it what it installed; the Hub mirrors that and manages nothing.
2. **Heimdall compares recorded with observed, on one System.** A recorded Service that stopped, a recorded job that missed its schedule, and a recorded file that changed are Heimdall's to report.
3. **The provisioner compares declared with recorded.** Heimdall stores no provisioner's declarations. Gaps such as declared but not installed are found by the provisioner's own check, which reads the records the Hub mirrors.
4. **Heimdall reports and never manages.** Nothing the Hub sends changes a Collector's records or what it observes.
5. **Every record is optional.** A System nobody records anything on still shows its Vitals and its agent Sessions.
6. **The Hub keeps agent Session transcripts** as the durable record of agent work, after each Harness deletes its own copy.

## Recording what a provisioner installed

A provisioner records something it installed by piping one JSON object to `heimdall-collector record <kind>`, and removes it with `heimdall-collector forget <kind> <name>`. It runs both as the account the Collector runs as, so the records land in that Collector's state, even when the install itself ran as another account such as root. The kinds are `application`, `service`, `job`, and `files`.

`record` reads at most 1 MiB from standard input and refuses a terminal. It exits 1, stores nothing, and names the field and the problem when the input is empty, is not JSON, fails the rules below, or carries a field the kind does not list; it never repeats the input. A mistake therefore fails the provisioner's command at once, and a field is never dropped without notice. On success it prints `Recorded <kind> <name>.` and exits 0. Recording a kind and name again replaces the record. `forget` removes the record and exits 0 with `No <kind> <name> is recorded.` when there is none, so an uninstall script can run it whether or not the install was recorded. Forgetting a job also removes its runs.

Records live in `records.sqlite` in the Collector's state directory, which `record` creates, readable by its owner alone, if it is missing. Pairing is not required. Wiping the directory loses the records, and the provisioner records them again. A new kind or supervisor is added only when a provisioner needs it.

### Fields

A name is 1 to 128 characters: letters, digits, `.`, `_`, and `-`, starting with a letter or digit. A text field is 1 to 256 characters of well-formed Unicode with no control characters. Every kind may carry `provenance`, which is optional: `by`, text of at most 64 characters, and optionally `revision`, text of at most 128. Heimdall shows it and never compares it.

| Kind | Fields |
| --- | --- |
| `application` | `name`, `version` (text of at most 128 characters), optional `source` (text), optional `provenance`. |
| `service` | `name`, `supervisor`, optional `health`, optional `port`, optional `provenance`. The supervisor decides what names the Service to it: `unit` for `systemd` and `systemd-user`, `label` for `launchd`, `container` for `docker`, and no target for `none`. A `systemd` or `systemd-user` `unit` names one unit, since `systemctl` reads a name with `*`, `?`, or `[` as a pattern that can match several units or none, and a name of only digits as a job id; such a `unit` is refused. `health` is `http://127.0.0.1:<port>` or `http://[::1]:<port>`, optionally followed by a path of printable ASCII other than space, with a port from 1 to 65535; `localhost` and every other host are refused. `port` is an integer from 1 to 65535. |
| `job` | `name`, `scheduler`, `schedule`, optional `graceMinutes`, optional `provenance`. The scheduler decides what names the job to it: `label` for `launchd`, `unit` for `systemd-timer`. `schedule` lists 1 to 100 calendar entries in the System's local time, with the meaning of launchd's `StartCalendarInterval`: each entry has at least one of `minute` (0 to 59), `hour` (0 to 23), `day` (1 to 31), `weekday` (0 to 7, where 0 and 7 are both Sunday), and `month` (1 to 12), all integers, and a field left out matches every value. Two identical entries, with weekday 0 and 7 counted as equal, are refused. `graceMinutes`, an integer from 1 to 10,080, is how long the System must be awake after a scheduled time before the Hub raises job overdue; it is 60 when left out. Recording a job again keeps its runs. |
| `files` | `name`, `files` (1 to 10,000 entries of `path` and `sha256`), optional `provenance`. A `path` is absolute and normalized, at most 4096 bytes, and has no control characters: it has no empty, `.`, or `..` segment and no trailing slash, and `/` alone is not a file. Paths within a record are unique. A `sha256` is 64 lowercase hexadecimal characters. |

A job reports each run with `heimdall-collector record run <job>`, which reads one JSON object from standard input like the other kinds. The job must have a `job` record, and the command exits 1 for a run of one that has none. A run has `started` and `finished`, UTC times in ISO 8601 with whole seconds such as `2026-10-01T03:00:05Z`, where `finished` is not earlier than `started`; `exitStatus`, an integer from 0 to 255, where 0 is success; and optionally `output`, with `file`, the output file's name without any directory, and `sizeBytes`, a non-negative integer. Runs are keyed by job and `started`, so recording the same start again replaces the run. Recording a run prunes that job's runs that started more than 90 days earlier, except the job's latest successful run. A run that is itself that old, and not the latest success, is not kept: the command exits 0 and prints `Run of <job> started <started> is older than 90 days and was not kept.` instead of `Recorded run of <job> started <started>.` A job's runner should ignore a failure to record, so a broken Collector never fails the job.

### Examples

```json
{"name": "webapp", "version": "1.4.2", "source": "https://example.com/webapp-1.4.2.tar.gz", "provenance": {"by": "my-provisioner", "revision": "3f9c2ab"}}
```

```json
{"name": "webapp", "supervisor": "systemd", "unit": "webapp.service", "health": "http://127.0.0.1:8080/healthz", "port": 8080}
```

```json
{"name": "nightly-backup", "scheduler": "systemd-timer", "unit": "nightly-backup.timer", "schedule": [{"hour": 3, "minute": 30}]}
```

```json
{"name": "webapp-config", "files": [{"path": "/etc/webapp/webapp.conf", "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}]}
```

```json
{"started": "2026-10-01T03:30:00Z", "finished": "2026-10-01T03:42:17Z", "exitStatus": 0, "output": {"file": "backup-2026-10-01.tar.gz", "sizeBytes": 73400320}}
```

The last example is the input to `heimdall-collector record run nightly-backup`.

### What Heimdall checks and reports

The Collector reports its records to the Hub, as [Reading the records back](#reading-the-records-back) describes, and checks those it can observe. The Hub raises the job Conditions described in [Job Conditions](#job-conditions), the stale System and low disk Conditions described in [System Conditions](#system-conditions), Drift as described in [Drift](#drift), and Service down as described in [Service down](#service-down). The Collector checks a Service's supervisor when it is `systemd` or `systemd-user`; the checks of `launchd` and `docker` Services and of health URLs are planned for later M4 work.

| Kind | Heimdall checks and reports |
| --- | --- |
| `application` | Reported as recorded; the version is not observed. |
| `service` | Supervisor state for `systemd` and `systemd-user` Services, which the Collector asks each minute; a stopped Service raises Service down. _Planned:_ the state of `launchd` and `docker` Services, and health from the URL, which the Collector will request only on loopback; an unhealthy Service will raise Service down too. A Service whose supervisor the Collector does not check yet is reported as unchecked, never as down. |
| `job` | Each run the job reports. A failed latest run raises job failing; a scheduled time followed by a grace period of awake time, with no successful run since, raises job overdue. |
| `files` | Each file's current hash, which the Collector compares with the recorded one. A file that no longer matches, or no longer exists, raises Drift. A file the Collector cannot read is reported as unreadable and raises nothing. |

A new field reaches the dashboard only when every layer knows it, so the Hub is upgraded first, then the Collectors, and only then does a provisioner send the field.

### Job Conditions

The Hub judges every System's recorded jobs once a minute, from the records and latest runs it mirrors, the System's time zone, and the System's Vitals. Each job Condition is about one job and names it on the page and the Timeline.

- **Job failing** is raised when the job's latest run exited with a status other than 0, and its reason names the run's start and exit status. A later failing run replaces the reason. It clears when the latest run succeeds.
- **Job overdue** is raised when one of the job's scheduled times passed, the System was then awake for the job's grace period, and no successful run started at or after that scheduled time. Its reason names the scheduled time in the System's local time, and it clears once such a run is reported. A job can be failing and overdue at once.

Awake time is counted from the Vitals samples the Hub stored, which a Collector takes every 15 seconds while its System is awake. The Hub counts each 5-minute rollup bucket as awake for 15 seconds per sample, up to the whole bucket, and counts no bucket later than its own clock. A System asleep through a scheduled time therefore gets its whole grace period after it wakes, as does one whose Collector stopped. The Hub looks back at most 90 days; a System not awake for the grace period within them leaves job overdue as it is. Samples and runs both carry the System's own clock.

The Hub reads a schedule's entries as wall-clock times in the System's time zone. As in cron, an entry that names both `day` and `weekday` fires on either, and `month` always applies. launchd also fires on either, but ignores `month` for a weekday, so the Hub never expects a run launchd would skip. A time that a clock change skips falls as much later as the clock skips, and one it repeats falls the first time. Scheduled times count only from when the Hub first mirrored the job, so a job recorded today is not overdue for a time that passed before. Recording a job again keeps that time, and so does a record set over budget or one that lists the job as unreadable; only a set that leaves the job out forgets it.

A job Condition stays as it is while what decides it is unknown: while the System's record set or runs are over budget, while the Collector or the Hub cannot read the job's record or runs, while the System has never sent runs, and, for job overdue, while the Hub has no time zone for the System or does not know its zone. A job whose record is forgotten clears both.

## System Conditions

Once a minute, in the same pass as the job Conditions and one after the other, the Hub judges every paired System for two Conditions about the System itself.

- **Stale System** is raised when the Hub last heard from the System more than 10 minutes ago, or more than 7 days ago when the System sleeps. Any Report counts as hearing from it, including one the Hub rejects, and so does any transcript upload. A paired System the Hub has never heard from counts from when it was paired, so a Collector that never starts is stale too. The Hub then holds a row for that System with no last seen, and the page shows it as never seen. A System with a last seen counts from that time even if it was paired again since, so pairing it again does not clear the Condition. The Condition has no subject, its reason names the time the System was last heard from (or paired, if never), and it clears at the next judgment after the System is heard from again.
- **Low disk** is raised for a mount whose free space in the System's latest Vitals sample is below 10% of its size, and clears when it is above 15%. Between the two an open Condition stays open and a mount that is not low stays unraised, so a mount near the limit does not flap. The subject is the mount, and the reason gives its free space and its percentage, such as `9.9 GiB free of 100.0 GiB (9.9%).`; a Condition that stays open takes the newer reason when it changes. A mount that leaves the latest sample clears its Condition. A mount with a size of 0 is left as it is. A mount listed more than once in a sample is judged by its entry with the least free space. A System with no readable sample is not judged for disk.
- **The latest sample** is the newest one stamped no later than 5 minutes after the Hub's clock, since the Hub does not store when it received a sample, and a System whose clock runs ahead would otherwise keep its newest, wrongly stamped sample as the latest for as long as the clock is wrong.
- **A System that is no longer paired** is not judged, and the next judgment clears its open stale System and low disk Conditions. Its other Conditions and its history stay.

The limits are named constants that the Hub passes to the evaluation as parameters, so that Hub configuration can supply them later.

The Collector says whether its System sleeps with `sleeps = true` in `collector.toml`, `--sleeps`, or `HEIMDALL_SLEEPS`, and false when left out, and puts that in every Report as the boolean `sleeps`. The Hub stores the latest value it received. A Report without `sleeps`, from a Collector that predates it, leaves the stored value as it is, and so does one whose `sleeps` is not a boolean, which the Hub drops without rejecting the Report. A System that has never sent it counts as always on. Upgrade the Hub, then the Collectors: a laptop whose Collector predates `sleeps` is stale after 10 minutes until it is upgraded and configured.

## Drift

The Collector hashes every file in its `files` records with SHA-256 when it starts, right after the `files` records change, and an hour after the last time it hashed them. Recording a run, an application, or the same `files` record again does not start a pass. It follows symbolic links and hashes one file at a time, reading each as a stream, so a large file is never held in memory, and reading no more than the file's size when it opened it, so a file that keeps growing cannot stall a pass. It reads no file a provisioner keeps as its own record, and hashes only the paths its own `files` records name. A pass stops between chunks when the Collector stops. A read that hangs, as on an unreachable network mount, cannot be cancelled and holds the pass until the operating system returns. Each file is in one of four states:

- **Matching**: the content hashes to the recorded value.
- **Drifted**: the content hashes to another value.
- **Missing**: no file exists at the path, including a symbolic link whose target does not exist, or a path under something that is not a directory.
- **Unreadable**: the Collector could not read the content, such as when permission is denied, when the path is a directory, a device, or a named pipe, or when symbolic links loop.

The Collector reports every file that is not matching in the `checks` section described under [Reading the records back](#reading-the-records-back), with the record that names it, the state, and `since`, the Collector's clock when it first saw the file in that state. A file that stays in one state keeps its `since` for as long as the Collector runs, and one that changes state takes the time of the pass that saw it. A restart forgets `since`, so a file still mismatched then takes the time of the first pass after it. The section also lists, for each `files` record the pass hashed, the record's name and its digest.

A record's digest is the SHA-256, in lowercase hexadecimal, of its files in path order, compared by UTF-16 code unit, each written as the path, a NUL byte, the recorded `sha256`, and a newline. The order in which the provisioner listed the files does not matter. A record and the checks about it reach the Hub apart, so the Hub computes the digest of each `files` record it mirrors and trusts the Collector's verdict on the record only when the checks list the record with the same digest. A record the checks do not list, or list with another digest, has not been judged as the Hub knows it, and every path it names is unknown.

The Hub judges every System's checks once a minute, in the same pass as the [job Conditions](#job-conditions) and the [System Conditions](#system-conditions), after them. Drift is one Condition per path, whichever records name it, and its subject is the path.

- **Drift** is raised for a path that a judged record names and the checks list as drifted or missing. Its reason says whether the file changed or is missing, and names the first such record by name, compared by code unit; the Condition takes the new reason when the file goes from one to the other. A path several records name is raised if any judged record shows it drifted or missing.
- **Drift clears** when every record that names the path was judged and shows the file matching, and when no `files` record the Hub mirrors names the path at all, which is how forgetting a record clears its Drift. Neither clears while any `files` record is unreadable.

Drift stays as it is while what decides it is unknown: while the Collector reports the path unreadable, for the paths of a record the checks did not judge as the Hub mirrors it, while the System's record set is over budget, while the System has never sent checks, and while any `files` record is unreadable, whether the Collector could not read it or the Hub does not know its shape, since that record may name the path. While a `files` record is unreadable no path's Drift clears, though a path a judged record shows drifted or missing is still raised. A files part over budget judges no record, so it leaves every path a record names as it is, but a path no record names clears, so forgetting a record clears its Drift even then. A Condition raised for a path the Collector can no longer read therefore stays open until the Collector reads it again, or the record is forgotten, which clears it only while no `files` record is unreadable.

## Service down

The Collector checks every `service` record once a minute, in a loop of its own, so the hourly file hashing never delays it. A Service has one supervisor check, and a health check will join it beside the supervisor check. Each check is in one of four states:

- **Up**: the supervisor says the Service is running.
- **Stopped**: the supervisor says it is not running.
- **Unknown**: the Collector could not ask the supervisor, or got no answer.
- **Unchecked**: the Collector does not check this supervisor yet, which holds for `launchd`, `docker`, and `none`.

For a `systemd` Service the Collector runs `systemctl show --property=ActiveState,SubState,LoadState -- <unit>` and for a `systemd-user` Service the same with `systemctl --user`, so the first asks the system manager and the second the account's user manager. It runs `systemctl` by absolute path, from the first of `/usr/bin`, `/bin`, and `/usr/local/bin` that has it, since a launchd agent or a systemd service has a minimal PATH, and gives it 5 seconds before it kills it. An `ActiveState` of `active` is up, including a unit that exited and remains. Any other `ActiveState` is stopped, including `activating`, which a unit that fails and restarts shows between attempts, and so is a unit systemd does not know (`LoadState=not-found`). A check is unknown when `systemctl` cannot reach the manager, as when the account has no user bus (the error says it failed to connect to the bus, or that systemd was not booted), when it exits non-zero for any other reason, when it times out or cannot run, when it is not installed, or when its answer lacks the states asked for or is not about exactly one unit. A stopped Service is therefore never confused with one the Collector could not ask.

Each check carries its state, a short `detail` of at most 200 characters, such as `ActiveState=failed`, `LoadState=not-found`, or `bus unavailable`, and `since`, the Collector's clock when it first saw the check in this state. The Collector reports them in the `services` part of the [checks section](#reading-the-records-back), which it sends again only when a check's state or detail changes and hourly like the rest of the section, so a Service that stays in one state causes no resend. A restart forgets `since`.

The Hub judges Service down once a minute for every System, in the same pass as the other Conditions and after Drift. It is one Condition per Service, whatever checks the Service has, and its subject is the Service's name.

- **Service down** is raised for a Service the Hub mirrors a record for once any of its checks has been failing, today stopped, for 2 minutes. Its reason says why the Service is down, such as `Stopped: ActiveState=failed.`, and names the first failing check, the supervisor before the others; a Condition that stays open takes the newer reason when it changes. The Hub counts the time a check has been failing as awake time, the way [job overdue](#job-conditions) counts the awake time after a scheduled time, but per 15-second Vitals sample: 15 seconds for each sample the System took after the check's `since`, from the raw samples the Hub keeps. A check that has failed for 8 samples has failed for 2 minutes, wherever `since` falls in a 5-minute rollup bucket. Samples and `since` are on the System's own clock, so the Hub's clock is never compared with it and counts for nothing, and a System whose clock is off by a steady amount is judged as right as one whose clock is exact; a clock stepped while a check is failing shifts the count by the step. Samples a System stamped ahead before its clock was set back still count, so a check that starts failing soon after such a correction can be raised early. Silence and sleep add no samples, so they add no time: a System that goes quiet after a Report that said stopped raises nothing however long it stays quiet, and one that wakes after sleeping through most of the 2 minutes is not raised until it has been awake for the rest.
- **Service down clears** when every check the Collector made passes, and when no `service` record the Hub mirrors names the Service, which is how forgetting a record clears it. Forgetting does not clear it while any `service` record is unreadable, whether the Collector could not read it or the Hub does not know its shape, since that record may be the Service.

Service down stays as it is while what decides it is unknown: while any of the Service's checks is unknown, while a check that fails has not yet failed for 2 minutes of the System's awake time, while a Service has only unchecked checks, while the System has never sent checks or its checks carry no `services` part (a Collector older than Service checks), while the `services` part is over budget, and while the System's record set is over budget. A `files` part over budget does not stop Services from being judged. A check for a Service the Hub mirrors no record for is not judged.

## Reading the records back

The Collector sends its whole record set in a Report's `records` section when it starts, when a `record` or `forget` changes the set, and an hour after the Hub last answered a Report carrying the set. The section carries each record as the provisioner recorded it and the kind and name of each record the Collector could not read from its own state. A row whose kind or name the section cannot carry, which only a damaged state file holds, is left out, and the Collector logs a warning. A job's runs are not part of the set.

The Collector sends its jobs' latest runs in a Report's `runs` section when it starts, when a `record run` or `forget` changes them, and an hour after the Hub last answered a Report carrying them, so recording a run does not resend the record set. For each job that has reported a run, the section carries its latest run and its latest successful run, which may be the same run, or `null` when none of the runs the Collector keeps succeeded. A job whose latest run or latest success the Collector cannot read is listed by name as unreadable. Runs whose JSON is larger than 1 MiB are sent as their size alone.

The Collector sends the results of its checks in a Report's `checks` section when it starts, when they change, and an hour after the Hub last answered a Report carrying them. The section has parts, one for each kind of check, and the Collector builds them in loops of their own, so a part waits for no other. The files part has two fields, `fileRecords` and `files`. `fileRecords` lists each `files` record the Collector hashed, as the record's name (`record`) and its `digest`, which [Drift](#drift) defines. `files` lists only the recorded files in those records that are not matching. Each entry has the `record` that names the file, its `path`, its `state` (`drifted`, `missing`, or `unreadable`), and `since`, the Collector's clock as epoch milliseconds. A record whose row the Collector cannot read, or holds under a name other than its own or one the section cannot carry, is not listed in `fileRecords`, and the Collector logs a warning for the latter. An empty `files` beside a `fileRecords` that lists a record says every file in it matches, and is how the Hub learns that Drift has cleared. A section without a `files` part says the Collector has not finished a file pass yet, or is newer than this Hub, and judges no record.

The services part is `services`, which lists each check of each recorded Service: its `service` name, its `check` kind (`supervisor` now, and `health` when health checks are built), its `state` (`up`, `stopped`, `unknown`, or `unchecked`), its `detail`, and `since`, the Collector's clock as epoch milliseconds. [Service down](#service-down) defines them. An empty `services` says the Collector has no Service to check, and no `services` says nothing about any Service.

Every part is optional, and checks of other things join the section as further parts, so a section from a newer Collector that carries parts this Hub does not know, or only them, is still accepted, and the Hub drops what it does not know. The Collector sends no section until a loop has finished its first pass, and then sends the parts it has. Each part has a budget of 1 MiB of JSON. A part over it is sent as its size alone, in `overBudget` under the part's name (`files` or `services`), and the other parts are sent as they are, so a large files part never stops Services from being reported.

Every Report also carries the System's IANA time zone, such as `America/New_York`, in which its jobs' schedules are read. The Collector reads it on each Report from the zone `/etc/localtime` names, which is where systemd and macOS record the zone their schedulers follow, so a change of zone shows in the next Report. A Report carries no zone when `/etc/localtime` names none.

If the Hub refuses a Report carrying the set, the runs, or the checks, the Collector sends the same samples again without them, so none ever costs Vitals, and offers each again an hour later. A Report that would be too large for the Hub with them is sent without them, and they ride a later, smaller Report.

The Hub replaces the System's mirror with each set, so a forgotten record leaves the mirror, and replaces the System's latest runs and latest checks with each runs and checks section in the same way. It ignores a section sent earlier than the one it holds, unless the held one claims a time later than the Hub's own clock. A Report without a section leaves what the Hub holds for it unchanged, and one without a time zone keeps the zone the Hub holds.

The Hub drops a field it does not know from a mirrored record or run. It counts a record of a kind or shape it does not know as unreadable, since the record still exists on the System, and likewise a job whose latest runs it cannot read. A set whose JSON is larger than 8 MiB is sent as its size alone, and the Hub then holds no records for that System until a smaller set arrives; runs over budget likewise leave it no jobs, a files part over budget no files, and a services part over budget no Service checks. The Hub counts a file state it does not know as unreadable and a Service state it does not know as unknown, and drops a Service check of a kind it does not know. It ignores a time zone it does not accept and keeps the one it holds. The shapes are in `packages/schema/src/records-section.ts`, `packages/schema/src/runs-section.ts`, and `packages/schema/src/checks-section.ts`.

`GET /api/v1/records` returns every System's records, with the same trust as the dashboard. The answer lists each System the dashboard shows, sorted by name, in one of three forms:

```json
{"systems": [
  {"system": "web-1", "timeZone": "America/New_York",
   "sentAt": "2026-10-10T08:00:00.000Z", "receivedAt": "2026-10-10T08:00:01.250Z",
   "records": [{"kind": "job", "name": "nightly-backup", "record": {"name": "nightly-backup", "scheduler": "systemd-timer", "unit": "nightly-backup.timer", "schedule": [{"hour": 3, "minute": 30}]}}],
   "unreadable": [{"kind": "service", "name": "webapp"}],
   "checks": {"sentAt": "2026-10-10T07:43:00.000Z", "receivedAt": "2026-10-10T07:43:00.410Z",
              "fileRecords": [{"record": "webapp-config", "digest": "9f2b5c0e4a7d13d86b0c5e2f71a4d98c3e6b1f07a2d5c8e94b3f6a1d0c7e5b82"}],
              "files": [{"record": "webapp-config", "path": "/etc/webapp", "state": "unreadable", "since": "2026-10-10T07:41:12.000Z"},
                        {"record": "webapp-config", "path": "/etc/webapp/webapp.conf", "state": "drifted", "since": "2026-10-10T06:12:40.000Z"}],
              "services": [{"service": "webapp", "check": "supervisor", "state": "stopped", "detail": "ActiveState=failed", "since": "2026-10-10T07:40:05.000Z"}]},
   "runs": {"sentAt": "2026-10-10T07:43:00.000Z", "receivedAt": "2026-10-10T07:43:00.410Z",
            "jobs": [{"job": "nightly-backup",
                      "latestRun": {"started": "2026-10-10T07:30:00Z", "finished": "2026-10-10T07:30:09Z", "exitStatus": 1},
                      "latestSuccess": {"started": "2026-10-09T07:30:00Z", "finished": "2026-10-09T07:42:17Z", "exitStatus": 0,
                                        "output": {"file": "backup-2026-10-09.tar.gz", "sizeBytes": 73400320}}}],
            "unreadable": []}},
  {"system": "build-1", "timeZone": "UTC",
   "sentAt": "2026-10-10T08:00:00.000Z", "receivedAt": "2026-10-10T08:00:00.900Z",
   "overBudget": {"bytes": 9437184},
   "checks": {"sentAt": "2026-10-10T08:00:00.000Z", "receivedAt": "2026-10-10T08:00:00.900Z", "overBudget": {"files": {"bytes": 1310720}},
              "services": [{"service": "builder", "check": "supervisor", "state": "up", "detail": "ActiveState=active", "since": "2026-10-09T21:00:00.000Z"}]},
   "runs": {"sentAt": "2026-10-10T08:00:00.000Z", "receivedAt": "2026-10-10T08:00:00.900Z", "overBudget": {"bytes": 1310720}}},
  {"system": "laptop-1", "timeZone": null, "records": null, "checks": null, "runs": null}
]}
```

`records` is `null` until a Report carries the System's set, `runs` until a Report carries its runs, `checks` until a Report carries its checks, and `timeZone` until a Report names one, which a Collector older than each never sends. Such a System's records, runs, or checks are unknown, not empty. An entry's own `sentAt` and `receivedAt` are those of its record set, and `runs` and `checks` carry their own. `checks` holds the files that are not matching, so a file the Collector could not read shows there with the state `unreadable`, though it raises no Drift, and an empty `files` says every file in the records the Collector hashed matches. A checks entry with no `files` and no `fileRecords` says no file pass has reached the Hub yet, or that the part was sent over budget, which is not the same as an empty `files`: nothing has been judged. Its `fileRecords` lists each `files` record the Collector hashed with the [digest](#drift) it read, so a provisioner can tell checks that judged an older version of a record from the record the Hub mirrors now; a record missing from it, or listed with another digest, was not judged as mirrored. Its `services` lists each check of each Service with its state, detail, and `since`, so a provisioner can see which Services the Collector found stopped, unknown, or unchecked. A part sent over budget is left out and named in `overBudget` with its size, and `services`, `files`, and `fileRecords` are also left out when the Collector sent no such part, which is not the same as an empty list. Records are sorted by kind, then name, jobs' runs by job, checked records by record, checked files by record, then path, and Service checks by service, then check, each by code unit. Times are UTC in ISO 8601, including each file's and each Service check's `since`.

## Agent Session transcripts

A System captures transcripts only from the sources its Collector configuration lists ([ADR-0013](decisions/0013-transcripts-upload-as-acknowledged-chunks-into-postgresql.md)). Capture is off until a source is listed:

```toml
[[sessions.sources]]
harness = "claude-code"            # its standard directory

[[sessions.sources]]
harness = "claude-code"
dir = "~/.claude-work"             # a second profile
name = "claude-work"
```

Each source names a Harness, and optionally a directory and a name, which default to the Harness's standard location and its name. A directory is absolute or starts with `~/`. Two sources may not share a name or a directory, even through a symbolic link, and the Collector refuses to start with such a configuration or with a Harness it does not know. A source whose directory does not exist is skipped, so one configuration can list every source a fleet uses. The Collector reads each directory as its own account and reports each source as capturing, absent, or unreadable. Adding a source uploads the history already in it.

| Harness | Standard directory | Session tree |
| --- | --- | --- |
| `claude-code` | `~/.claude` | `projects/` |
| `codex` | `~/.codex` | `sessions/` |

The Collector uploads every file of a source's session tree to the Hub as it grows, separately from Reports, as gzipped chunks the Hub acknowledges by offset. It keeps content the Hub has not acknowledged in a spool, so a Harness pruning its files loses nothing. It reads the trees every 60 seconds, reads only regular files, follows no symbolic link inside a tree, and skips a file whose name is not UTF-8, which has no path the Hub accepts. A JSONL file's chunks end on line boundaries; a last line without a newline, and a whole file that is not JSONL, upload once the file is unchanged across two scans. The Hub stores transcripts as written and keeps them until they are deleted on purpose.

### Upload protocol

A Collector uploads with its System's token as a bearer token, like a Report. The limits and request shapes are in `packages/schema/src/transcripts.ts`.

1. **Open a generation** for each file the Collector has not uploaded before, and whenever a file it has uploaded shrinks, is replaced, or stops matching what it uploaded: `POST /api/v1/transcripts/generations` with `{"source": "claude-code", "path": "projects/my-project/0b1c.jsonl"}`. The path is relative to the source's directory, as the directory lists it, with `/` between segments, and is valid UTF-8 of at most 4096 bytes; a file whose name cannot be written so has no path the Hub accepts. The Hub answers `201` with `{"generation": 42, "held": 0}`.
2. **Send each chunk** of the file in order: `POST /api/v1/transcripts/generations/42/chunks` with the gzipped chunk as the body, as one gzip member or several concatenated, and its offset, counted in bytes of the file before compression, in the `Heimdall-Offset` header. A chunk carries at most 1 MiB of the file and its body at most 2 MiB. The Hub stores the chunk as uploaded and answers `{"held": <bytes of the file it holds>}` in the same transaction.

| Answer | Meaning | The Collector |
| --- | --- | --- |
| `200 {"held": n}` | The chunk is stored, or the Hub held it already. | Removes what the Hub holds from its spool. |
| `409 {"held": n}` | The offset is not where the Hub's content ends. | Resumes from `n` when its spool continues there. Otherwise, as when the Hub holds more than the file has, the file starts over in a new generation. |
| `410` to an open | Every generation at the path was deleted on purpose. | Stops uploading the path and drops its spooled content. |
| `410` to a chunk | The generation was deleted on purpose. A newer generation at the same path may survive. | Drops the generation's spooled content. If the file still grows into it, opens a new generation at the path, and stops the path when that open is refused. |
| `404` | The System opened no such generation. | Opens a new generation when the spool still holds the file from its first byte; otherwise drops the spooled content, and the file starts over in a new generation at the next scan. |
| `401`, `403` | No token, or a token no System holds. | Keeps its spool and retries. |
| `413`, `422` | The chunk body is over the cap, is not gzip, or unpacks past the chunk limit, or the request is malformed, such as an open with an invalid path or a body over 32 KiB. | Keeps that file's spool and retries after backing off, while other files still upload; it is a Collector bug. |

Every upload counts toward the System's Last seen, and no refusal raises a Condition. Every Report carries a `transcripts` section: each source's name, Harness, and status, and the spool's size and the time of its oldest content. A Collector that captures nothing sends no sources and, once what a removed source left is uploaded, an empty spool. The Hub keeps each System's section from the latest Report it was sent in; a Report from a Collector older than this section leaves it unchanged.

`heimdall-hub transcripts delete` deletes whole generations that match every filter given: `--system`, `--source`, and `--before <date>`, which compares a generation's last upload with the start of that day in UTC. At least one filter is required, and `--dry-run` reports what would be deleted. Once every generation at a path is deleted, the Hub refuses new generations there.

The Collector observes each Session's processes from the process table, recording only executable names and working directories, never command-line arguments or environment variables.

## Trust

Collectors send Reports with their System's token, but the dashboard and `GET /api/v1/records` have no authentication; they rely on a tailnet only its operator can reach. Its database holds every transcript, including anything an agent read. Authentication, and handling of secrets in transcripts, come before Heimdall is used anywhere else.
