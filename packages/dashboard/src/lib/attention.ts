import type { ConditionLevel } from '@heimdall/schema';

import type {
  Attention,
  AttentionKind,
  JobTarget,
  ServiceTarget,
} from '../server/attention-types.ts';
import type { Disk, JobRun, ServiceCheck } from '../server/system-detail-types.ts';
import { KIND_NAMES } from './conditions.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { scheduleWords } from './recorded.ts';

// What each kind of attention is called: the Hub's Conditions, plus the two
// the dashboard raises itself.
export const ATTENTION_NAMES: Record<AttentionKind, string> = {
  ...KIND_NAMES,
  checks_missing: 'Checks missing',
  file_unreadable: 'File unreadable',
};

// Whether the evidence holds the failure up: only a current check, run, or
// sample confirms it. An unreadable file or a missing check set never does.
export const isConfirmed = (item: Attention): boolean => item.evidence === 'current';

// Whether the dashboard raised the item itself, rather than the Hub.
const isOwn = (item: Attention) =>
  item.kind === 'file_unreadable' || item.kind === 'checks_missing';

// Evidence freshness is separate from the Hub's stored judgment. Only items
// without a Hub Condition have no level.
export const attentionMark = (item: Attention): ConditionLevel | 'unknown' =>
  item.level ?? 'unknown';

// Keeps case, dots, underscores, and tildes, and doubles a dash before other
// runs become one, so paths that differ only in those keep apart.
const slug = (text: string) =>
  text
    .replaceAll('-', '--')
    .replaceAll(/[^A-Za-z0-9._~-]+/gu, '-')
    .replaceAll(/^-|-$/gu, '');

// An HTML id for the item, unique on its System: the kind and its subject.
export const anchorOf = (item: Attention): string => {
  if (item.kind === 'checks_missing') {
    return `checks-missing-${item.set}`;
  }
  const kind = item.kind.replaceAll('_', '-');
  const subject = slug(item.subject);
  return subject === '' ? kind : `${kind}-${subject}`;
};

const MARK_RANK: Record<ConditionLevel | 'unknown', number> = {
  alert: 0,
  note: 2,
  unknown: 3,
  warning: 1,
};

// Items on a System still paired first, then the most severe, then the Hub's
// Conditions before what the dashboard raises itself, then the newest.
const byPriority = (a: Attention, b: Attention) =>
  Number(a.unpaired) - Number(b.unpaired) ||
  MARK_RANK[attentionMark(a)] - MARK_RANK[attentionMark(b)] ||
  Number(isOwn(a)) - Number(isOwn(b)) ||
  b.firstDetected - a.firstDetected;

// Splits items into the confirmed failures and the unconfirmed evidence, each
// in the order the operator should read them. Does not change its input.
export const rankAttention = (
  items: readonly Attention[],
): { confirmed: Attention[]; unconfirmed: Attention[] } => ({
  confirmed: items.filter(isConfirmed).toSorted(byPriority),
  unconfirmed: items.filter((item) => !isConfirmed(item)).toSorted(byPriority),
});

// What a System's lane says: its worst open level that calls for action,
// regardless of evidence freshness. Notes alone leave it healthy.
export const laneSummary = (
  items: readonly Attention[],
): { lead: Attention | undefined; more: number; unconfirmed: number } => {
  const actionable = items
    .filter((item) => item.level === 'warning' || item.level === 'alert')
    .toSorted(byPriority);
  const lead = actionable[0];
  const unconfirmed = items.filter((item) => !isConfirmed(item));
  return {
    lead,
    more: actionable.filter((item) => item !== lead && isConfirmed(item)).length,
    unconfirmed: unconfirmed.length,
  };
};

// What the item is about: its subject; the set for a missing check set; empty
// for a Condition about the whole System, which the page already names.
export const subjectText = (item: Attention): string => {
  switch (item.kind) {
    case 'checks_missing': {
      return item.set === 'checks' ? 'Service and file checks' : 'Job runs';
    }
    case 'reports_rejected':
    case 'system_stale': {
      return '';
    }
    default: {
      return item.subject;
    }
  }
};

// A check's detail as the end of a sentence, without a doubled full stop.
const tail = (detail: string) => (detail === '' ? '' : `: ${detail.replace(/\.$/u, '')}`);

const truncate = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

// "3f9a…c21e": the first and last four characters of a hash.
const shortHash = (sha256: string) =>
  sha256.length > 8 ? `${sha256.slice(0, 4)}…${sha256.slice(-4)}` : sha256;

const GIB = 1024 ** 3;

// How long a reason may be in a table cell.
const SHORT_LIMIT = 80;

const SUPERVISOR_WORDS: Record<string, string> = {
  docker: 'Docker container',
  launchd: 'launchd service',
  systemd: 'systemd unit',
  'systemd-user': 'systemd user unit',
};

const CHECK_STATE_WORDS: Record<string, string> = {
  stopped: 'Stopped',
  unchecked: 'Not checked',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
};

// The content a files record holds for a path, in long and short form.
const recordedContent = (
  record: string | undefined,
  sha256: string | undefined,
): { long: string; short: string } => {
  const where = record === undefined ? '' : ` in ${record}`;
  if (sha256 === undefined) {
    return {
      long:
        record === undefined
          ? 'Content as the provisioner recorded it'
          : `Content as recorded${where}`,
      short: 'As recorded',
    };
  }
  return {
    long: `Content with sha256 ${shortHash(sha256)}, as recorded${where}`,
    short: `sha256 ${shortHash(sha256)}`,
  };
};

type Words = { long: Phrase; short: Phrase };

const same = (text: string): Words => ({ long: [text], short: [text] });

// How the latest checks found a drifted file. With no state, only a current
// check that judged its record says it matched.
const driftObserved = (
  state: 'drifted' | 'missing' | 'unreadable' | undefined,
  { checkedAt, evidence }: Pick<Attention, 'checkedAt' | 'evidence'>,
): Words => {
  if (state === undefined && evidence === 'unknown') {
    return {
      long: ['Unknown. The latest checks did not judge the version of its record the Hub holds.'],
      short: ['Not checked against its record'],
    };
  }
  if (state === undefined && evidence === 'old') {
    return checkedAt === undefined
      ? { long: ['Unknown. No file check has arrived.'], short: ['Not checked'] }
      : {
          long: ['Unknown. No file check has arrived in the last 2 hours.'],
          short: ['No recent check'],
        };
  }
  switch (state) {
    case 'drifted': {
      return {
        long: [
          'Content differs. Heimdall holds no observed hash or content, only that it differs.',
        ],
        short: ['Changed: content differs'],
      };
    }
    case 'missing': {
      return { long: ['The file does not exist.'], short: ['Missing'] };
    }
    case 'unreadable': {
      return {
        long: [
          'The Collector cannot read the file now, so Heimdall cannot tell whether it matches.',
        ],
        short: ['Unreadable now'],
      };
    }
    default: {
      return {
        long: ['The file matched at the latest check. The Hub clears this within a minute.'],
        short: ['Matched at the latest check'],
      };
    }
  }
};

// The checks that are not up, as "Stopped: inactive (dead)", else the reason.
const serviceObserved = (checks: readonly ServiceCheck[], reason: string): Words => {
  const down = checks
    .filter(({ state }) => state !== 'up')
    .map(({ check, detail, state }) => {
      const word = CHECK_STATE_WORDS[state] ?? state;
      return `${check === 'health' ? `Health URL ${word.toLowerCase()}` : word}${tail(detail)}`;
    });
  const [first] = down;
  if (first === undefined) {
    return { long: [reason], short: [truncate(reason, SHORT_LIMIT)] };
  }
  return { long: [`${down.join('. ')}.`], short: [first] };
};

const jobFailingObserved = (latestRun: JobRun | undefined, now: number): Words =>
  latestRun === undefined
    ? { long: ['Heimdall holds no run of this job.'], short: ['No run'] }
    : {
        long: [
          `Exited with status ${String(latestRun.exitStatus)} in the run that started `,
          whenAt(latestRun.started, now),
          '.',
        ],
        short: [`Exit status ${String(latestRun.exitStatus)}`],
      };

const jobOverdueObserved = (
  latestSuccess: JobRun | undefined,
  reason: string,
  now: number,
): Words =>
  latestSuccess === undefined
    ? { long: [`Never succeeded. ${reason}`], short: ['Never succeeded'] }
    : {
        long: ['Last success ', whenAt(latestSuccess.started, now), `. ${reason}`],
        short: ['Last success ', whenAt(latestSuccess.started, now)],
      };

const diskObserved = (disk: Disk | undefined, reason: string): Words => {
  if (disk === undefined || disk.totalBytes <= 0) {
    return { long: [reason], short: [reason] };
  }
  const free = disk.totalBytes - disk.usedBytes;
  const percent = ((free / disk.totalBytes) * 100).toFixed(1);
  const text = `${(free / GIB).toFixed(1)} GiB free of ${(disk.totalBytes / GIB).toFixed(1)} GiB (${percent}%)`;
  return { long: [`${text}.`], short: [text] };
};

const staleObserved = (lastSeenAt: number | undefined, now: number): Words =>
  lastSeenAt === undefined
    ? { long: ['Never heard from this System.'], short: ['Never heard from'] }
    : {
        long: ['Last heard from ', whenAt(lastSeenAt, now), '.'],
        short: ['Last heard from ', whenAt(lastSeenAt, now)],
      };

const missingObserved = (
  set: 'checks' | 'runs',
  checkedAt: number | undefined,
  now: number,
): Words => {
  const shown = set === 'checks' ? 'Service and file states' : 'job runs';
  return checkedAt === undefined
    ? { long: [`None received. The ${shown} shown may be out of date.`], short: ['None received'] }
    : {
        long: ['None since ', whenAt(checkedAt, now), `. The ${shown} shown may be out of date.`],
        short: ['None since ', whenAt(checkedAt, now)],
      };
};

type EvidenceWords = {
  context: string | undefined;
  expected: Phrase;
  expectedShort: Phrase;
  observed: Phrase;
  observedShort: Phrase;
};

const evidence = (expected: Words, observed: Words, context?: string): EvidenceWords => ({
  context,
  expected: expected.long,
  expectedShort: expected.short,
  observed: observed.long,
  observedShort: observed.short,
});

const othersWords = (count: number, record = 'the record') =>
  count === 1
    ? `1 other recorded file in ${record} matches.`
    : `${String(count)} other recorded files in ${record} match.`;

// What the Condition expected and what was observed instead, each in a long
// and a short form, with the times left as Moments. The long forms are full
// sentences; the short forms fit a table cell.
export const evidenceWords = (item: Attention, now: number): EvidenceWords => {
  switch (item.kind) {
    case 'drift': {
      const recorded = recordedContent(item.record, item.sha256);
      return evidence(
        { long: [recorded.long], short: [recorded.short] },
        driftObserved(item.state, item),
        item.othersMatching > 0 ? othersWords(item.othersMatching, item.record) : undefined,
      );
    }
    case 'file_unreadable': {
      const recorded = recordedContent(item.record, item.sha256);
      return evidence(
        { long: [recorded.long], short: [recorded.short] },
        {
          long: [
            'Unknown. The Collector could not read the file, so Heimdall cannot say whether it matches. This is not Drift.',
          ],
          short: ['Unreadable'],
        },
      );
    }
    case 'service_down': {
      const supervisor =
        item.service === undefined ? undefined : SUPERVISOR_WORDS[item.service.supervisor];
      const running = supervisor === undefined ? 'Running' : `Running (${supervisor})`;
      const health = item.service?.health === undefined ? '' : ', health URL answers';
      return evidence(
        { long: [`${running}${health}`], short: ['Running'] },
        serviceObserved(item.checks, item.reason),
      );
    }
    case 'job_failing': {
      return evidence(same('Exit status 0'), jobFailingObserved(item.latestRun, now));
    }
    case 'job_overdue': {
      const words = scheduleWords(item.schedule);
      return evidence(
        {
          long: [`A successful run after each scheduled time (${words})`],
          short: [words],
        },
        jobOverdueObserved(item.latestSuccess, item.reason, now),
      );
    }
    case 'low_disk': {
      return evidence(
        {
          long: ['Disk use within the limits configured in the Hub for this System.'],
          short: ['Within the Hub disk limits'],
        },
        diskObserved(item.disk, item.reason),
      );
    }
    case 'system_stale': {
      return evidence(
        same(`A Report within ${item.sleeps ? '7 days' : '10 minutes'}`),
        staleObserved(item.lastSeenAt, now),
      );
    }
    case 'reports_rejected': {
      return evidence(same('Reports the Hub accepts'), {
        long: [item.reason],
        short: [truncate(item.reason, SHORT_LIMIT)],
      });
    }
    case 'checks_missing': {
      return evidence(
        { long: ['With every Report, at least hourly'], short: ['With every Report'] },
        missingObserved(item.set, item.checkedAt, now),
      );
    }
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
};

// What the item rests on, for the word "arrived" in its note.
const arrivedThing = (item: Attention) => {
  if (item.kind === 'job_failing' || item.kind === 'job_overdue') {
    return 'run';
  }
  return item.kind === 'low_disk' ? 'Vitals sample' : 'check';
};

// Why the item's evidence is weaker than a current check, or undefined when it
// is not: old evidence names when the last one arrived, unknown evidence says
// why the latest check cannot tell. An unreadable file's observed state
// already says why, so it adds nothing.
export const evidenceNote = (item: Attention, now: number): Phrase | undefined => {
  if (item.evidence === 'current') {
    return undefined;
  }
  if (item.evidence === 'old') {
    const thing = arrivedThing(item);
    return item.checkedAt === undefined
      ? [`No ${thing} has ever arrived, so this may be out of date.`]
      : [
          `No ${thing} has arrived since `,
          whenAt(item.checkedAt, now),
          ', over 2 hours ago, so this may be out of date.',
        ];
  }
  if (item.kind === 'drift' && item.state === undefined) {
    return [
      'The latest checks did not judge the version of its record the Hub holds, so they cannot tell whether the file matches.',
    ];
  }
  if (item.kind === 'file_unreadable') {
    return undefined;
  }
  if (item.kind === 'drift') {
    return [
      'The latest check could not read this file, so it cannot tell whether the file matches.',
    ];
  }
  if (item.kind === 'service_down') {
    return [
      'The latest check of this Service could not tell whether it is running, or has not checked it.',
    ];
  }
  return ['The latest check could not tell, so this may be out of date.'];
};

export type NextStep = { commands: string[]; text: string; title: string };

// A path or name as one shell word, quoted when it holds anything unusual.
const shellWord = (text: string) =>
  /^[\w@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", String.raw`'\''`)}'`;

// The commands that read a Service's log and that start it, by supervisor;
// both empty for a Service with no supervisor to ask.
const serviceCommands = (
  service: ServiceTarget | undefined,
): { log: string[]; start: string[] } => {
  const target = service?.target;
  if (service === undefined || target === undefined) {
    return { log: [], start: [] };
  }
  const word = shellWord(target);
  switch (service.supervisor) {
    case 'systemd-user': {
      return {
        log: [`journalctl --user -u ${word} -n 50`],
        start: [`systemctl --user start ${word}`],
      };
    }
    case 'systemd': {
      return { log: [`journalctl -u ${word} -n 50`], start: [`sudo systemctl start ${word}`] };
    }
    case 'launchd': {
      return {
        log: [`launchctl print gui/$(id -u)/${word}`],
        start: [`launchctl kickstart gui/$(id -u)/${word}`],
      };
    }
    case 'docker': {
      return { log: [`docker logs --tail 50 ${word}`], start: [`docker start ${word}`] };
    }
    default: {
      return { log: [], start: [] };
    }
  }
};

// The command that reads why a job's last run went wrong or never came: a
// timer's service holds the log, not the timer.
const jobLogCommands = (job: JobTarget | undefined): string[] => {
  if (job === undefined) {
    return [];
  }
  switch (job.scheduler) {
    case 'launchd': {
      return [`launchctl print gui/$(id -u)/${shellWord(job.target)}`];
    }
    case 'systemd-timer': {
      return [`journalctl -u ${shellWord(job.target.replace(/\.timer$/u, '.service'))} -n 50`];
    }
    default: {
      return [];
    }
  }
};

const USER_TIMER_HINT = ' For a user timer, add --user after journalctl.';

// The Collector finds launchd jobs in the user's domain and the system's, and
// the record does not say which.
const LAUNCH_DAEMON_HINT = ' For a LaunchDaemon, use sudo and system/ in place of gui/$(id -u)/.';

// What the commands cannot know about where the scheduler keeps the job.
const timerHint = (job: JobTarget | undefined) => {
  if (job?.scheduler === 'systemd-timer') {
    return USER_TIMER_HINT;
  }
  return job?.scheduler === 'launchd' ? LAUNCH_DAEMON_HINT : '';
};

const step = (title: string, text: string, commands: string[] = []): NextStep => ({
  commands,
  text,
  title,
});

const RE_APPLY_SHORT = "Re-apply, or change the provisioner's source";

const driftSteps = (item: Attention & { kind: 'drift' }) => {
  const record = item.record ?? 'this file';
  const recorder = `the provisioner that recorded ${record} on ${item.system}`;
  if (item.state === 'missing') {
    return [
      step(
        'Restore the file',
        `Re-apply ${recorder}. It recreates the file and the next file check clears this.`,
      ),
      step(
        'Stop recording the file',
        `Change the provisioner so it no longer records the file${item.record === undefined ? '' : ` in ${item.record}`}, then re-apply. The Condition clears.`,
      ),
    ];
  }
  return [
    step(
      'Restore the managed content',
      `Re-apply ${recorder}. The file goes back to the recorded content and the next file check clears this.`,
    ),
    step(
      'Accept the new content',
      "Change the provisioner's source so it installs this content, then re-apply. It records the new hash and the Condition clears.",
    ),
  ];
};

const serviceSteps = (item: Attention & { kind: 'service_down' }) => {
  const { log, start } = serviceCommands(item.service);
  const supervisorCheck = item.checks.find(({ check }) => check !== 'health');
  const healthCheck = item.checks.find(({ check }) => check === 'health');
  const health = item.service?.health;
  const retire = step(
    'Remove it if it should no longer run',
    `If ${item.subject} should no longer run, remove it from the provisioner so its record drops it.`,
  );
  if (
    health !== undefined &&
    supervisorCheck?.state === 'up' &&
    healthCheck !== undefined &&
    healthCheck.state !== 'up'
  ) {
    return {
      short: 'Find out why it is unhealthy',
      steps: [
        step(
          'Find out why it is unhealthy',
          `On ${item.system}, see what the health URL answers and read ${item.subject}'s log.`,
          [`curl -i ${shellWord(health)}`, ...log],
        ),
        retire,
      ],
    };
  }
  return {
    short: log.length > 0 ? 'Read its log, then start it' : 'Find out why, then start it',
    steps: [
      step(
        'Find out why, then start it',
        `On ${item.system}, read ${item.subject}'s log to see why it stopped, then start it.${item.service?.supervisor === 'launchd' ? LAUNCH_DAEMON_HINT : ''}`,
        [...log, ...start],
      ),
      retire,
    ],
  };
};

// What the operator can do about the item, as short words for a table cell
// and as steps with the commands to run. Heimdall never acts on a System, and
// the dashboard never writes: these are instructions.
export const nextSteps = (item: Attention): { short: string; steps: NextStep[] } => {
  switch (item.kind) {
    case 'drift': {
      return { short: RE_APPLY_SHORT, steps: driftSteps(item) };
    }
    case 'service_down': {
      return serviceSteps(item);
    }
    case 'job_failing': {
      return {
        short: 'Read why the run failed, then fix it',
        steps: [
          step(
            'Find out why the run failed',
            `On ${item.system}, read why the latest run of ${item.subject} failed, fix it, then run it again.${timerHint(item.job)}`,
            jobLogCommands(item.job),
          ),
        ],
      };
    }
    case 'job_overdue': {
      return {
        short: 'Run it by hand; read why it missed',
        steps: [
          step(
            'Run it, then find why it missed',
            `Run ${item.subject} by hand if it should not wait for its next scheduled time. Then find why it missed: ${item.system} may have slept through the scheduled time.${timerHint(item.job)}`,
            jobLogCommands(item.job),
          ),
        ],
      };
    }
    case 'low_disk': {
      return {
        short: 'Free space or grow the disk',
        steps: [
          step(
            'Free space or grow the disk',
            `On ${item.system}, find what fills ${item.subject} and remove it, or grow the disk.`,
            [`df -h ${shellWord(item.subject)}`],
          ),
        ],
      };
    }
    case 'system_stale': {
      return {
        short: 'Check it is on and its Collector runs',
        steps: [
          step(
            'Check the System and its Collector',
            `Check that ${item.system} is on and online and that its Collector runs.${item.sleeps ? ' It may be asleep; wake it so it can report.' : ''}`,
          ),
        ],
      };
    }
    case 'reports_rejected': {
      return {
        short: 'Upgrade the Collector or pair it again',
        steps: [
          step(
            'Read why the Hub rejects its Reports',
            `Read the reason. An outdated Collector or a token for another System are the usual causes: upgrade the Collector on ${item.system} or pair it again.`,
          ),
        ],
      };
    }
    case 'file_unreadable': {
      return {
        short: 'Let the Collector read it, or unrecord it',
        steps: [
          step(
            'Make it checkable',
            `Let the Collector's user read the file, or have the provisioner leave it out of ${item.record}. Until then, whether it drifted is unknown.`,
          ),
        ],
      };
    }
    case 'checks_missing': {
      const what = item.set === 'checks' ? 'its Service and file checks' : 'its job runs';
      return {
        short: "Read the Collector's log",
        steps: [
          step(
            'Check the Collector',
            `On ${item.system}, read the Collector's log for errors from ${what}.`,
          ),
        ],
      };
    }
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
};
