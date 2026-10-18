import { describe, expect, test } from 'bun:test';

import type { ConditionLevel } from '@heimdall/schema';

import type { Attention, AttentionFacts } from '../server/attention-types.ts';
import {
  ATTENTION_NAMES,
  anchorOf,
  attentionMark,
  evidenceNote,
  evidenceWords,
  isConfirmed,
  laneSummary,
  nextSteps,
  rankAttention,
  subjectText,
} from './attention.ts';
import { phraseText, whenAt, zoneFreeText } from './phrase.ts';
import type { Phrase } from './phrase.ts';

// Tuesday 2026-10-06 16:00 UTC.
const NOW = Date.UTC(2026, 9, 6, 16, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GIB = 1024 ** 3;

const utc = (phrase: Phrase) => phraseText(phrase, 'UTC');

const DRIFT: AttentionFacts = {
  kind: 'drift',
  othersMatching: 0,
  record: 'dotfiles',
  sha256: '3f9a7c0d11aa22bb33cc44dd55ee66ff77889900aabbccddeeff00112233c21e',
  state: 'drifted',
};

// An item with sensible defaults: current evidence, checked a minute ago.
type AttentionCommon = Pick<
  Attention,
  'checkedAt' | 'evidence' | 'firstDetected' | 'subject' | 'system' | 'unpaired'
>;
type AttentionOverrides = Partial<AttentionCommon> & { level?: ConditionLevel };

function attention<F extends AttentionFacts>(
  facts: F,
  over?: AttentionOverrides,
): Extract<Attention, { kind: F['kind'] }>;
function attention(facts: AttentionFacts, over: AttentionOverrides = {}): Attention {
  const { level, ...overrides } = over;
  const common: AttentionCommon = {
    checkedAt: NOW - MINUTE,
    evidence: 'current',
    firstDetected: NOW - HOUR,
    subject: '',
    system: 'valhalla',
    unpaired: false,
    ...overrides,
  };
  if (facts.kind === 'checks_missing' || facts.kind === 'file_unreadable') {
    return { ...common, ...facts };
  }
  return {
    ...common,
    ...facts,
    conditionId: 'condition-1',
    level: level ?? (facts.kind === 'drift' || facts.kind === 'job_overdue' ? 'warning' : 'alert'),
  };
}

test('hot process attention names the process and offers investigation without a stop command', () => {
  const item = attention(
    {
      kind: 'hot_process',
      reason: 'compiler (PID 42) above 0.5 cores for 30 minutes in 60 minutes.',
    },
    { level: 'note', subject: JSON.stringify(['boot-1', 42, '123', 'compiler']) },
  );
  expect(subjectText(item)).toBe('compiler (PID 42)');
  expect(evidenceWords(item, NOW).observed).toEqual([item.reason]);
  expect(nextSteps(item)).toMatchObject({
    short: "Inspect this process's CPU use",
    steps: [{ commands: [] }],
  });
  expect(nextSteps(item).steps[0]?.text).toContain('compiler (PID 42)');
  expect(nextSteps(item).steps[0]?.text).toContain('valhalla');
  expect(utc(evidenceNote({ ...item, evidence: 'old' }, NOW) ?? [])).toContain('Vitals sample');
});

const drift = (over: Partial<Extract<AttentionFacts, { kind: 'drift' }>> = {}, subject = '/f') =>
  attention({ ...DRIFT, ...over }, { subject });

const check = (state: string, detail = '', name = 'supervisor') => ({
  check: name,
  detail,
  since: NOW - HOUR,
  state,
});

const service = (
  supervisor: string,
  target: string | undefined,
  checks = [check('stopped', 'inactive (dead)')],
  health?: string,
) =>
  attention(
    {
      checks,
      kind: 'service_down',
      reason: 'Stopped.',
      service: { health, supervisor, target },
    },
    { subject: 'caddy' },
  );

const failing = (scheduler: string, target: string, exitStatus = 3) =>
  attention(
    {
      job: { scheduler, target },
      kind: 'job_failing',
      latestRun: { exitStatus, finished: NOW - HOUR + MINUTE, started: NOW - HOUR },
    },
    { subject: 'backup' },
  );

const overdue = (over: Partial<Extract<AttentionFacts, { kind: 'job_overdue' }>> = {}) =>
  attention(
    {
      job: { scheduler: 'launchd', target: 'com.example.backup' },
      kind: 'job_overdue',
      latestSuccess: { exitStatus: 0, finished: NOW - 20 * HOUR, started: NOW - 20 * HOUR },
      reason: 'Scheduled for 03:00 CEST; no successful run since.',
      schedule: [{ hour: 3, minute: 0 }],
      ...over,
    },
    { subject: 'backup' },
  );

const lowDisk = (disk: { mount: string; totalBytes: number; usedBytes: number } | undefined) =>
  attention(
    { disk, kind: 'low_disk', reason: '9.0 GiB free of 100.0 GiB (9.0%).' },
    { subject: '/' },
  );

const stale = (lastSeenAt: number | undefined, sleeps = false) =>
  attention({ kind: 'system_stale', lastSeenAt, reason: 'No Report.', sleeps });

const unreadable = (over: AttentionOverrides = {}) =>
  attention(
    { kind: 'file_unreadable', record: 'dotfiles', sha256: 'a71c000000000000000009d4' },
    { evidence: 'unknown', subject: '/etc/sudoers.d/fleet', ...over },
  );

const missing = (set: 'checks' | 'runs') =>
  attention({ kind: 'checks_missing', set }, { checkedAt: NOW - 3 * HOUR, evidence: 'old' });

const neverChecked = (set: 'checks' | 'runs') =>
  attention({ kind: 'checks_missing', set }, { checkedAt: undefined, evidence: 'old' });

describe('names and marks', () => {
  test('keeps a stored level when its evidence becomes old or unknown', () => {
    const item = { ...lowDisk(undefined), level: 'alert' as const };
    expect(attentionMark(item)).toBe('alert');
    expect(attentionMark({ ...item, evidence: 'old' })).toBe('alert');
    expect(attentionMark({ ...item, evidence: 'unknown' })).toBe('alert');
    expect(attentionMark({ ...item, level: 'note' })).toBe('note');
  });

  test('Condition kinds keep their names and the two dashboard-only kinds get theirs', () => {
    expect(ATTENTION_NAMES.drift).toBe('Drift');
    expect(ATTENTION_NAMES.system_stale).toBe('Stale System');
    expect(ATTENTION_NAMES.file_unreadable).toBe('File unreadable');
    expect(ATTENTION_NAMES.checks_missing).toBe('Checks missing');
  });

  test('only current evidence confirms an item', () => {
    expect(isConfirmed(drift())).toBe(true);
    expect(isConfirmed(attention(DRIFT, { evidence: 'old' }))).toBe(false);
    expect(isConfirmed(attention(DRIFT, { evidence: 'unknown' }))).toBe(false);
  });

  test('file_unreadable and checks_missing are never confirmed', () => {
    expect(isConfirmed(unreadable())).toBe(false);
    expect(isConfirmed(missing('checks'))).toBe(false);
  });

  test('an item takes its stored Condition level as its mark', () => {
    expect(attentionMark(service('systemd', 'caddy.service'))).toBe('alert');
    expect(attentionMark(failing('launchd', 'x'))).toBe('alert');
    expect(attentionMark(drift())).toBe('warning');
  });

  test('only evidence without a Hub Condition is marked unknown', () => {
    expect(attentionMark(attention(DRIFT, { evidence: 'old' }))).toBe('warning');
    expect(attentionMark(unreadable())).toBe('unknown');
    expect(attentionMark(missing('runs'))).toBe('unknown');
  });
});

describe('anchorOf', () => {
  test('is the kind with dashes and the slugged subject', () => {
    expect(anchorOf(drift({}, '/home/someone/.zshrc'))).toBe('drift-home-someone-.zshrc');
    expect(anchorOf(failing('launchd', 'x'))).toBe('job-failing-backup');
  });

  test('slugs keep case, dots, and underscores, collapse other runs, and trim dashes', () => {
    expect(anchorOf(drift({}, '//Etc/Sudoers.d//Fleet_X//'))).toBe('drift-Etc-Sudoers.d-Fleet_X');
  });

  test('slugs keep paths apart that differ only in a dot or case', () => {
    expect(anchorOf(drift({}, '/etc/foo.conf'))).not.toBe(anchorOf(drift({}, '/etc/foo-conf')));
    expect(anchorOf(drift({}, '/home/x/.zshrc'))).not.toBe(anchorOf(drift({}, '/home/x/zshrc')));
    expect(anchorOf(drift({}, '/A'))).not.toBe(anchorOf(drift({}, '/a')));
    expect(anchorOf(drift({}, '/etc/app/config.toml'))).not.toBe(
      anchorOf(drift({}, '/etc-app/config.toml')),
    );
  });

  test('omits the slug part when the subject is empty or has nothing to slug', () => {
    expect(anchorOf(stale(undefined))).toBe('system-stale');
    expect(anchorOf(drift({}, '//'))).toBe('drift');
  });

  test('a missing check set is named by its set', () => {
    expect(anchorOf(missing('checks'))).toBe('checks-missing-checks');
    expect(anchorOf(missing('runs'))).toBe('checks-missing-runs');
  });

  test('an unreadable file anchors apart from Drift on the same path', () => {
    expect(anchorOf(unreadable())).toBe('file-unreadable-etc-sudoers.d-fleet');
  });
});

describe('rankAttention', () => {
  test('orders confirmed items by stored level, then newest first', () => {
    const oldDrift = attention(DRIFT, { firstDetected: 1, subject: 'a' });
    const newDrift = attention(DRIFT, { firstDetected: 2, subject: 'b' });
    const down = { ...service('systemd', 'caddy.service'), firstDetected: NOW };
    const failingJob = failing('launchd', 'x');
    const { confirmed } = rankAttention([oldDrift, failingJob, newDrift, down]);
    expect(confirmed).toEqual([down, failingJob, newDrift, oldDrift]);
  });

  test('puts unconfirmed items apart, newest first', () => {
    const older = unreadable({ firstDetected: 1, subject: '/a' });
    const newer = unreadable({ firstDetected: 2, subject: '/b' });
    const { confirmed, unconfirmed } = rankAttention([older, drift(), newer]);
    expect(confirmed).toHaveLength(1);
    expect(unconfirmed).toEqual([newer, older]);
  });

  test('puts Conditions the Hub raised before what the dashboard raises itself', () => {
    const oldDown = attention(
      { checks: [], kind: 'service_down', reason: 'x', service: undefined },
      { evidence: 'old', firstDetected: 1 },
    );
    const newer = unreadable({ firstDetected: 2 });
    expect(rankAttention([newer, oldDown]).unconfirmed).toEqual([oldDown, newer]);
  });

  test('puts items on unpaired Systems last in each group', () => {
    const gone = attention(DRIFT, { firstDetected: NOW, unpaired: true });
    const paired = attention(DRIFT, { firstDetected: 1 });
    const goneDown = attention(
      { checks: [], kind: 'service_down', reason: 'x', service: undefined },
      { unpaired: true },
    );
    const oldGone = attention(DRIFT, { evidence: 'old', unpaired: true });
    const oldPaired = attention(DRIFT, { evidence: 'old', firstDetected: 0 });
    const { confirmed, unconfirmed } = rankAttention([goneDown, gone, paired, oldGone, oldPaired]);
    expect(confirmed).toEqual([paired, goneDown, gone]);
    expect(unconfirmed).toEqual([oldPaired, oldGone]);
  });

  test('does not mutate its input', () => {
    const items = [attention(DRIFT, { firstDetected: 1 }), service('systemd', 'x')];
    const copy = [...items];
    rankAttention(items);
    expect(items).toEqual(copy);
  });
});

describe('laneSummary', () => {
  test('counts actionable current Conditions apart from old evidence and notes', () => {
    const alert = { ...lowDisk(undefined), level: 'alert' as const };
    const warning = { ...lowDisk(undefined), level: 'warning' as const };
    const note = { ...lowDisk(undefined), level: 'note' as const };
    expect(laneSummary([alert, { ...warning, evidence: 'old' }])).toEqual({
      lead: alert,
      more: 0,
      unconfirmed: 1,
    });
    const oldAlert = { ...alert, evidence: 'old' as const };
    expect(laneSummary([oldAlert, warning, note])).toEqual({
      lead: oldAlert,
      more: 1,
      unconfirmed: 1,
    });
    expect(laneSummary([alert, note, { ...note, subject: '/data' }])).toEqual({
      lead: alert,
      more: 0,
      unconfirmed: 0,
    });
  });

  test('names the worst open level despite old evidence, and leaves notes healthy', () => {
    const note = { ...lowDisk(undefined), level: 'note' as const };
    const alert = { ...lowDisk(undefined), evidence: 'old' as const, level: 'alert' as const };
    const warning = { ...lowDisk(undefined), level: 'warning' as const };
    expect(laneSummary([warning, note, alert]).lead).toBe(alert);
    expect(laneSummary([note]).lead).toBeUndefined();
  });

  test('leads with the top confirmed item and counts the rest', () => {
    const down = service('systemd', 'caddy.service');
    const summary = laneSummary([drift(), down, drift({}, '/g'), unreadable(), missing('runs')]);
    expect(summary.lead).toBe(down);
    expect(summary.more).toBe(2);
    expect(summary.unconfirmed).toBe(2);
  });

  test('has no lead when nothing is confirmed', () => {
    expect(laneSummary([unreadable()])).toEqual({ lead: undefined, more: 0, unconfirmed: 1 });
    expect(laneSummary([])).toEqual({ lead: undefined, more: 0, unconfirmed: 0 });
  });
});

describe('subjectText', () => {
  test('is the subject for most kinds', () => {
    expect(subjectText(drift({}, '/etc/x'))).toBe('/etc/x');
    expect(subjectText(unreadable())).toBe('/etc/sudoers.d/fleet');
  });

  test('names the missing set', () => {
    expect(subjectText(missing('checks'))).toBe('Service and file checks');
    expect(subjectText(missing('runs'))).toBe('Job runs');
  });

  test('is empty for Conditions about the whole System', () => {
    expect(subjectText(stale(NOW))).toBe('');
    expect(subjectText(attention({ kind: 'reports_rejected', reason: 'x' }))).toBe('');
  });
});

describe('evidenceWords: drift', () => {
  test('expects the recorded content, hash shortened', () => {
    const words = evidenceWords(drift(), NOW);
    expect(utc(words.expected)).toBe('Content with sha256 3f9a…c21e, as recorded in dotfiles');
    expect(utc(words.expectedShort)).toBe('sha256 3f9a…c21e');
  });

  test('says what was recorded when no hash is held', () => {
    const words = evidenceWords(drift({ sha256: undefined }), NOW);
    expect(utc(words.expected)).toBe('Content as recorded in dotfiles');
    expect(utc(words.expectedShort)).toBe('As recorded');
    expect(utc(evidenceWords(drift({ record: undefined, sha256: undefined }), NOW).expected)).toBe(
      'Content as the provisioner recorded it',
    );
  });

  test('leaves a hash too short to shorten whole', () => {
    expect(utc(evidenceWords(drift({ sha256: 'abc123' }), NOW).expectedShort)).toBe(
      'sha256 abc123',
    );
  });

  test('observes changed content without inventing a hash', () => {
    const words = evidenceWords(drift(), NOW);
    expect(utc(words.observed)).toBe(
      'Content differs. Heimdall holds no observed hash or content, only that it differs.',
    );
    expect(utc(words.observedShort)).toBe('Changed: content differs');
  });

  test('observes a missing file', () => {
    const words = evidenceWords(drift({ state: 'missing' }), NOW);
    expect(utc(words.observed)).toBe('The file does not exist.');
    expect(utc(words.observedShort)).toBe('Missing');
  });

  test('observes a file the Collector cannot read now', () => {
    const words = evidenceWords(drift({ state: 'unreadable' }), NOW);
    expect(utc(words.observed)).toContain('Collector cannot read');
    expect(utc(words.observed)).toContain('cannot tell');
    expect(utc(words.observedShort)).toBe('Unreadable now');
  });

  test('observes that the latest checks did not judge the file in its recorded version', () => {
    const words = evidenceWords(drift({ state: undefined }, '/f'), NOW);
    const unjudged = evidenceWords(
      attention({ ...DRIFT, state: undefined }, { evidence: 'unknown' }),
      NOW,
    );
    expect(utc(unjudged.observedShort)).toBe('Not checked against its record');
    expect(utc(unjudged.observed)).toBe(
      'Unknown. The latest checks did not judge the version of its record the Hub holds.',
    );
    expect(utc(words.observedShort)).toBe('Matched at the latest check');
  });

  test('claims no match for a file with old evidence and no state', () => {
    const recent = attention(
      { ...DRIFT, state: undefined },
      { checkedAt: NOW - 3 * HOUR, evidence: 'old' },
    );
    const never = attention(
      { ...DRIFT, state: undefined },
      { checkedAt: undefined, evidence: 'old' },
    );
    expect(utc(evidenceWords(recent, NOW).observed)).toBe(
      'Unknown. No file check has arrived in the last 2 hours.',
    );
    expect(utc(evidenceWords(recent, NOW).observedShort)).toBe('No recent check');
    expect(utc(evidenceWords(never, NOW).observed)).toBe('Unknown. No file check has arrived.');
    expect(utc(evidenceWords(never, NOW).observedShort)).toBe('Not checked');
  });

  test('observes a file that matched at the latest check when its state is gone', () => {
    const words = evidenceWords(drift({ state: undefined }), NOW);
    expect(utc(words.observed)).toBe(
      'The file matched at the latest check. The Hub clears this within a minute.',
    );
    expect(utc(words.observedShort)).toBe('Matched at the latest check');
  });

  test('gives the other matching files as context only when there are some', () => {
    expect(evidenceWords(drift(), NOW).context).toBeUndefined();
    expect(evidenceWords(drift({ othersMatching: 137 }), NOW).context).toBe(
      '137 other recorded files in dotfiles match.',
    );
    expect(evidenceWords(drift({ othersMatching: 1 }), NOW).context).toBe(
      '1 other recorded file in dotfiles matches.',
    );
  });
});

describe('evidenceWords: service_down', () => {
  test('expects the Service running under its supervisor', () => {
    expect(utc(evidenceWords(service('systemd-user', 'caddy.service'), NOW).expected)).toBe(
      'Running (systemd user unit)',
    );
    expect(utc(evidenceWords(service('docker', 'web'), NOW).expected)).toBe(
      'Running (Docker container)',
    );
  });

  test('adds the health URL when the record names one', () => {
    const item = service('systemd', 'caddy.service', undefined, 'http://127.0.0.1:80');
    expect(utc(evidenceWords(item, NOW).expected)).toBe(
      'Running (systemd unit), health URL answers',
    );
    expect(utc(evidenceWords(item, NOW).expectedShort)).toBe('Running');
  });

  test('observes the checks that are not up, with their detail', () => {
    const words = evidenceWords(service('systemd-user', 'caddy.service'), NOW);
    expect(utc(words.observed)).toBe('Stopped: inactive (dead).');
    expect(utc(words.observedShort)).toBe('Stopped: inactive (dead)');
  });

  test('lists every check that is not up, and leaves out the ones that are', () => {
    const item = service('systemd', 'caddy.service', [
      check('up'),
      check('unhealthy', 'status 502.', 'health'),
    ]);
    expect(utc(evidenceWords(item, NOW).observed)).toBe('Health URL unhealthy: status 502.');
    const both = service('systemd', 'caddy.service', [
      check('stopped', 'inactive (dead)'),
      check('unknown', '', 'health'),
    ]);
    expect(utc(evidenceWords(both, NOW).observed)).toBe(
      'Stopped: inactive (dead). Health URL unknown.',
    );
    expect(utc(evidenceWords(both, NOW).observedShort)).toBe('Stopped: inactive (dead)');
  });

  test('falls back to the reason when every check is up', () => {
    const item = service('systemd', 'caddy.service', [check('up')]);
    expect(utc(evidenceWords(item, NOW).observed)).toBe('Stopped.');
    expect(utc(evidenceWords(item, NOW).observedShort)).toBe('Stopped.');
  });
});

describe('evidenceWords: jobs', () => {
  test('job_failing observes the exit status and a Moment for the run start', () => {
    const words = evidenceWords(failing('launchd', 'x', 3), NOW);
    expect(utc(words.expected)).toBe('Exit status 0');
    expect(words.observed).toContainEqual(whenAt(NOW - HOUR, NOW));
    expect(utc(words.observed)).toBe('Exited with status 3 in the run that started 15:00.');
    expect(utc(words.observedShort)).toBe('Exit status 3');
  });

  test('job_failing with no run says so', () => {
    const item = attention({ job: undefined, kind: 'job_failing', latestRun: undefined });
    const words = evidenceWords(item, NOW);
    expect(utc(words.observed)).toBe('Heimdall holds no run of this job.');
    expect(utc(words.observedShort)).toBe('No run');
  });

  test('job_overdue expects a run after each scheduled time, in the schedule words', () => {
    const words = evidenceWords(overdue(), NOW);
    expect(utc(words.expected)).toBe('A successful run after each scheduled time (Daily at 03:00)');
    expect(utc(words.expectedShort)).toBe('Daily at 03:00');
  });

  test('job_overdue observes the last success as a Moment and adds the Hub reason', () => {
    const words = evidenceWords(overdue(), NOW);
    expect(words.observed).toContainEqual(whenAt(NOW - 20 * HOUR, NOW));
    expect(utc(words.observed)).toBe(
      'Last success Mon 20:00. Scheduled for 03:00 CEST; no successful run since.',
    );
    expect(utc(words.observedShort)).toBe('Last success Mon 20:00');
  });

  test('job_overdue that never succeeded says so', () => {
    const words = evidenceWords(overdue({ latestSuccess: undefined }), NOW);
    expect(utc(words.observedShort)).toBe('Never succeeded');
    expect(utc(words.observed)).toBe(
      'Never succeeded. Scheduled for 03:00 CEST; no successful run since.',
    );
  });
});

describe('evidenceWords: System Conditions', () => {
  test('low_disk refers to the Hub limits instead of assuming fleet defaults', () => {
    const words = evidenceWords(lowDisk(undefined), NOW);
    expect(utc(words.expectedShort)).toBe('Within the Hub disk limits');
    expect(utc(words.expected)).toBe(
      'Disk use within the limits configured in the Hub for this System.',
    );
  });

  test('low_disk observes free space with one decimal', () => {
    const words = evidenceWords(
      lowDisk({ mount: '/', totalBytes: 100 * GIB, usedBytes: 91 * GIB }),
      NOW,
    );
    expect(utc(words.observedShort)).toBe('9.0 GiB free of 100.0 GiB (9.0%)');
    expect(utc(words.observed)).toBe('9.0 GiB free of 100.0 GiB (9.0%).');
  });

  test('low_disk without the mount in the newest sample uses the reason', () => {
    const words = evidenceWords(lowDisk(undefined), NOW);
    expect(utc(words.observed)).toBe('9.0 GiB free of 100.0 GiB (9.0%).');
    expect(utc(words.observedShort)).toBe('9.0 GiB free of 100.0 GiB (9.0%).');
  });

  test('system_stale expects a Report in 10 minutes, or 7 days when it sleeps', () => {
    expect(utc(evidenceWords(stale(NOW), NOW).expected)).toBe('A Report within 10 minutes');
    expect(utc(evidenceWords(stale(NOW, true), NOW).expected)).toBe('A Report within 7 days');
  });

  test('system_stale observes when it was last heard from, as a Moment', () => {
    const words = evidenceWords(stale(NOW - 3 * HOUR), NOW);
    expect(words.observedShort).toContainEqual(whenAt(NOW - 3 * HOUR, NOW));
    expect(utc(words.observedShort)).toBe('Last heard from 13:00');
    expect(utc(words.observed)).toBe('Last heard from 13:00.');
  });

  test('system_stale that never reported says so', () => {
    const words = evidenceWords(stale(undefined), NOW);
    expect(utc(words.observedShort)).toBe('Never heard from');
    expect(utc(words.observed)).toBe('Never heard from this System.');
  });

  test('reports_rejected observes the reason, truncated in the short form', () => {
    const long = 'x'.repeat(200);
    const words = evidenceWords(attention({ kind: 'reports_rejected', reason: long }), NOW);
    expect(utc(words.expected)).toBe('Reports the Hub accepts');
    expect(utc(words.observed)).toBe(long);
    expect(utc(words.observedShort)).toBe(`${'x'.repeat(79)}…`);
    const short = evidenceWords(attention({ kind: 'reports_rejected', reason: 'Bad token.' }), NOW);
    expect(utc(short.observedShort)).toBe('Bad token.');
  });
});

describe('evidenceWords: dashboard-only kinds', () => {
  test('file_unreadable expects the recorded content like Drift', () => {
    expect(utc(evidenceWords(unreadable(), NOW).expected)).toBe(
      'Content with sha256 a71c…09d4, as recorded in dotfiles',
    );
  });

  test('file_unreadable observes nothing and says it is not Drift', () => {
    const words = evidenceWords(unreadable(), NOW);
    expect(utc(words.observed)).toBe(
      'Unknown. The Collector could not read the file, so Heimdall cannot say whether it matches. This is not Drift.',
    );
    expect(utc(words.observedShort)).toBe('Unreadable');
  });

  test('checks_missing expects checks with every Report', () => {
    const words = evidenceWords(missing('checks'), NOW);
    expect(utc(words.expected)).toBe('With every Report, at least hourly');
    expect(utc(words.expectedShort)).toBe('With every Report');
  });

  test('checks_missing observes none since a Moment and warns the shown states may be old', () => {
    const words = evidenceWords(missing('checks'), NOW);
    expect(words.observedShort).toContainEqual(whenAt(NOW - 3 * HOUR, NOW));
    expect(utc(words.observedShort)).toBe('None since 13:00');
    expect(utc(words.observed)).toBe(
      'None since 13:00. The Service and file states shown may be out of date.',
    );
    expect(utc(evidenceWords(missing('runs'), NOW).observed)).toBe(
      'None since 13:00. The job runs shown may be out of date.',
    );
  });

  test('checks_missing with nothing ever received says so', () => {
    expect(utc(evidenceWords(neverChecked('checks'), NOW).observedShort)).toBe('None received');
  });

  test('only Drift has context', () => {
    expect(evidenceWords(unreadable(), NOW).context).toBeUndefined();
    expect(evidenceWords(stale(NOW), NOW).context).toBeUndefined();
  });
});

describe('evidenceNote', () => {
  test('is undefined for current evidence', () => {
    expect(evidenceNote(drift(), NOW)).toBeUndefined();
  });

  test('names the last check for old evidence, as a Moment', () => {
    const note = evidenceNote(missing('checks'), NOW);
    expect(note).toContainEqual(whenAt(NOW - 3 * HOUR, NOW));
    expect(utc(note ?? [])).toBe(
      'No check has arrived since 13:00, over 2 hours ago, so this may be out of date.',
    );
  });

  test('says no run has arrived for a job item', () => {
    const old = attention(
      { job: undefined, kind: 'job_failing', latestRun: undefined },
      { checkedAt: NOW - 5 * HOUR, evidence: 'old' },
    );
    expect(utc(evidenceNote(old, NOW) ?? [])).toContain('No run has arrived since');
  });

  test('handles old evidence that never arrived', () => {
    const note = evidenceNote(attention(DRIFT, { checkedAt: undefined, evidence: 'old' }), NOW);
    expect(zoneFreeText(note ?? [])).toBe('No check has ever arrived, so this may be out of date.');
  });

  test('adds nothing for an unreadable file, whose observed state already says why', () => {
    expect(evidenceNote(unreadable(), NOW)).toBeUndefined();
  });

  test('says why a Drift whose file is now unreadable cannot be judged', () => {
    const item = attention({ ...DRIFT, state: 'unreadable' }, { evidence: 'unknown' });
    expect(zoneFreeText(evidenceNote(item, NOW) ?? [])).toBe(
      'The latest check could not read this file, so it cannot tell whether the file matches.',
    );
  });

  test('says why the checks cannot judge a file in a record they did not judge', () => {
    const item = attention({ ...DRIFT, state: undefined }, { evidence: 'unknown' });
    expect(zoneFreeText(evidenceNote(item, NOW) ?? [])).toBe(
      'The latest checks did not judge the version of its record the Hub holds, so they cannot tell whether the file matches.',
    );
  });

  test('says why a Service check cannot tell', () => {
    const item = attention(
      { checks: [], kind: 'service_down', reason: 'x', service: undefined },
      { evidence: 'unknown' },
    );
    expect(zoneFreeText(evidenceNote(item, NOW) ?? [])).toBe(
      'The latest check of this Service could not tell whether it is running, or has not checked it.',
    );
  });
});

describe('nextSteps: drift', () => {
  test('offers to restore or accept the content', () => {
    const { short, steps } = nextSteps(drift());
    expect(short).toBe("Re-apply, or change the provisioner's source");
    expect(steps.map(({ title }) => title)).toEqual([
      'Restore the managed content',
      'Accept the new content',
    ]);
    expect(steps[0]?.text).toBe(
      'Re-apply the provisioner that recorded dotfiles on valhalla. The file goes back to the recorded content and the next file check clears this.',
    );
    expect(steps[1]?.text).toBe(
      "Change the provisioner's source so it installs this content, then re-apply. It records the new hash and the Condition clears.",
    );
    expect(steps.every(({ commands }) => commands.length === 0)).toBe(true);
  });

  test('a missing file is restored by re-applying, or dropped from the record', () => {
    const { steps } = nextSteps(drift({ state: 'missing' }));
    expect(steps[0]?.text).toContain('recreates the file');
    expect(steps[1]?.title).toBe('Stop recording the file');
    expect(steps[1]?.text).toContain('no longer records the file');
  });

  test('copes with an unknown record', () => {
    const { steps } = nextSteps(drift({ record: undefined }));
    expect(steps[0]?.text).toContain('the provisioner that recorded this file on valhalla');
  });
});

const commands = (item: Attention) => nextSteps(item).steps[0]?.commands;

describe('nextSteps: service_down', () => {
  test('systemd user unit', () => {
    expect(commands(service('systemd-user', 'caddy.service'))).toEqual([
      'journalctl --user -u caddy.service -n 50',
      'systemctl --user start caddy.service',
    ]);
  });

  test('systemd system unit', () => {
    expect(commands(service('systemd', 'caddy.service'))).toEqual([
      'journalctl -u caddy.service -n 50',
      'sudo systemctl start caddy.service',
    ]);
  });

  test('launchd label', () => {
    expect(commands(service('launchd', 'com.example.caddy'))).toEqual([
      'launchctl print gui/$(id -u)/com.example.caddy',
      'launchctl kickstart gui/$(id -u)/com.example.caddy',
    ]);
  });

  test('launchd steps say how to reach a LaunchDaemon', () => {
    expect(nextSteps(service('launchd', 'com.example.caddy')).steps[0]?.text).toContain(
      'For a LaunchDaemon, use sudo and system/ in place of gui/$(id -u)/.',
    );
  });

  test('quotes names and URLs that the shell would read otherwise', () => {
    expect(commands(service('systemd', 'odd $(unit).service'))).toEqual([
      "journalctl -u 'odd $(unit).service' -n 50",
      "sudo systemctl start 'odd $(unit).service'",
    ]);
    expect(commands(service('launchd', 'com.example;x'))).toEqual([
      "launchctl print gui/$(id -u)/'com.example;x'",
      "launchctl kickstart gui/$(id -u)/'com.example;x'",
    ]);
    const healthy = service(
      'systemd-user',
      'caddy.service',
      [check('up'), check('unhealthy', 'status 502', 'health')],
      'http://127.0.0.1:2019/health?a=1&b=2',
    );
    expect(nextSteps(healthy).steps[0]?.commands[0]).toBe(
      "curl -i 'http://127.0.0.1:2019/health?a=1&b=2'",
    );
  });

  test('docker container', () => {
    expect(commands(service('docker', 'web'))).toEqual([
      'docker logs --tail 50 web',
      'docker start web',
    ]);
  });

  test('no supervisor, or no target, gives no commands', () => {
    expect(commands(service('none', undefined))).toEqual([]);
    expect(commands(service('systemd', undefined))).toEqual([]);
    expect(
      commands(attention({ checks: [], kind: 'service_down', reason: 'x', service: undefined })),
    ).toEqual([]);
  });

  test('always ends with removing it from the provisioner', () => {
    const { steps, short } = nextSteps(service('systemd', 'caddy.service'));
    expect(steps).toHaveLength(2);
    expect(steps[0]?.title).toBe('Find out why, then start it');
    expect(steps[1]?.text).toBe(
      'If caddy should no longer run, remove it from the provisioner so its record drops it.',
    );
    expect(short).toBe('Read its log, then start it');
  });

  test('a Service whose supervisor is up but health is not is checked at its URL first', () => {
    const item = service(
      'systemd-user',
      'caddy.service',
      [check('up'), check('unhealthy', 'status 502', 'health')],
      'http://127.0.0.1:2019/health',
    );
    const { short, steps } = nextSteps(item);
    expect(steps[0]?.title).toBe('Find out why it is unhealthy');
    expect(steps[0]?.commands).toEqual([
      'curl -i http://127.0.0.1:2019/health',
      'journalctl --user -u caddy.service -n 50',
    ]);
    expect(short).toBe('Find out why it is unhealthy');
  });

  test('a stopped supervisor check is not the health-only case', () => {
    const item = service(
      'systemd',
      'caddy.service',
      [check('stopped', 'inactive'), check('unhealthy', '', 'health')],
      'http://127.0.0.1:2019',
    );
    expect(nextSteps(item).steps[0]?.title).toBe('Find out why, then start it');
  });
});

describe('nextSteps: jobs', () => {
  test('job_failing on launchd prints the job', () => {
    const { steps } = nextSteps(failing('launchd', 'com.example.backup'));
    expect(steps[0]?.title).toBe('Find out why the run failed');
    expect(steps[0]?.commands).toEqual(['launchctl print gui/$(id -u)/com.example.backup']);
  });

  test('job_failing on a systemd timer reads the matching service, not the timer', () => {
    const { steps } = nextSteps(failing('systemd-timer', 'nightly-backup.timer'));
    expect(steps[0]?.commands).toEqual(['journalctl -u nightly-backup.service -n 50']);
    expect(steps[0]?.text).toContain('--user');
  });

  test('job_failing without a job target gives no commands', () => {
    const item = attention({ job: undefined, kind: 'job_failing', latestRun: undefined });
    expect(nextSteps(item).steps[0]?.commands).toEqual([]);
  });

  test('job_overdue says to run it by hand and mentions sleep', () => {
    const { short, steps } = nextSteps(overdue());
    expect(steps[0]?.title).toBe('Run it, then find why it missed');
    expect(steps[0]?.text).toContain('slept through');
    expect(steps[0]?.commands).toEqual(['launchctl print gui/$(id -u)/com.example.backup']);
    expect(short).toBe('Run it by hand; read why it missed');
  });

  test('job_overdue on a systemd timer rewrites .timer to .service', () => {
    const item = overdue({ job: { scheduler: 'systemd-timer', target: 'b.timer' } });
    expect(nextSteps(item).steps[0]?.commands).toEqual(['journalctl -u b.service -n 50']);
  });
});

describe('nextSteps: System and file kinds', () => {
  test('low_disk shows df for the mount', () => {
    const { steps } = nextSteps(lowDisk(undefined));
    expect(steps[0]?.title).toBe('Free space or grow the disk');
    expect(steps[0]?.commands).toEqual(['df -h /']);
  });

  test('low_disk quotes a mount with a space', () => {
    const item = attention(
      { disk: undefined, kind: 'low_disk', reason: 'x' },
      { subject: '/Volumes/My Disk' },
    );
    expect(nextSteps(item).steps[0]?.commands).toEqual(["df -h '/Volumes/My Disk'"]);
  });

  test('system_stale asks to check the System and its Collector', () => {
    const { steps } = nextSteps(stale(NOW));
    expect(steps[0]?.text).toBe(
      'Check that valhalla is on and online and that its Collector runs.',
    );
  });

  test('system_stale for a System that sleeps mentions it may be asleep', () => {
    expect(nextSteps(stale(NOW, true)).steps[0]?.text).toContain('may be asleep');
  });

  test('reports_rejected names the usual causes', () => {
    const { steps } = nextSteps(attention({ kind: 'reports_rejected', reason: 'x' }));
    expect(steps[0]?.text).toContain('outdated Collector');
    expect(steps[0]?.text).toContain('another System');
    expect(steps[0]?.text).toContain('pair it again');
  });

  test('file_unreadable offers to make it checkable', () => {
    const { short, steps } = nextSteps(unreadable());
    expect(steps[0]?.title).toBe('Make it checkable');
    expect(steps[0]?.text).toContain("Collector's user read the file");
    expect(steps[0]?.text).toContain('leave it out of dotfiles');
    expect(short).toBe('Let the Collector read it, or unrecord it');
  });

  test('checks_missing sends the operator to the Collector log', () => {
    const { steps } = nextSteps(missing('checks'));
    expect(steps[0]?.title).toBe('Check the Collector');
    expect(steps[0]?.text).toContain('On valhalla');
  });

  test('every short is terse and has no trailing full stop', () => {
    const items = [
      drift(),
      drift({ state: 'missing' }),
      service('systemd', 'x'),
      service('none', undefined),
      failing('launchd', 'x'),
      overdue(),
      lowDisk(undefined),
      stale(NOW),
      attention({ kind: 'reports_rejected', reason: 'x' }),
      unreadable(),
      missing('checks'),
      missing('runs'),
    ];
    for (const item of items) {
      const { short } = nextSteps(item);
      expect(short.length).toBeLessThanOrEqual(45);
      expect(short.endsWith('.')).toBe(false);
    }
  });
});

test.each([
  ['apt', '/var/lib/apt/lists', 'Install with apt upgrade', ['apt upgrade']],
  ['homebrew', '/opt/homebrew', 'Install with brew upgrade', ['/opt/homebrew/bin/brew upgrade']],
  [
    'homebrew',
    "/Users/o'neil/brew",
    'Install with brew upgrade',
    [String.raw`'/Users/o'\''neil/brew/bin/brew' upgrade`],
  ],
  ['macos', 'system', 'Install from Software Update', []],
  ['other', 'system', 'Review and install the updates', []],
])(
  'a %s update Condition at %s says how to install its packages',
  (manager, installation, short, installCommands) => {
    const pending = attention(
      { kind: 'pending_update', reason: '3 packages are out of date.' },
      { subject: JSON.stringify([manager, installation]) },
    );
    const steps = nextSteps(pending);
    expect(steps.short).toBe(short);
    expect(steps.short.length).toBeLessThanOrEqual(45);
    expect(steps.steps).toHaveLength(1);
    expect(steps.steps[0]?.commands).toEqual(installCommands);
    expect(steps.steps[0]?.text).toMatch(/^On \S+, review the pending packages/u);
  },
);

test('a clock skew card shows the Hub reason and points to the System time sync', () => {
  const skew = attention(
    { kind: 'clock_skew', reason: "Its clock is 42 s ahead of the Hub's." },
    { level: 'note' },
  );
  expect(subjectText(skew)).toBe('');
  expect(evidenceWords(skew, NOW)).toMatchObject({
    expected: ['Clock agrees with the Hub'],
    observed: ["Its clock is 42 s ahead of the Hub's."],
  });
  const steps = nextSteps(skew);
  expect(steps.short).toBe('Check its time sync');
  expect(steps.steps).toHaveLength(1);
  expect(steps.steps[0]?.text).toContain('NTP');
});

test('a clock skew card that blames the Hub points to the Hub time sync first', () => {
  const skew = attention(
    { kind: 'clock_skew', reason: "The Hub's clock is 3 min 2 s ahead of 3 other Systems." },
    { evidence: 'old', level: 'warning' },
  );
  const steps = nextSteps(skew);
  expect(steps.short).toBe("Check the Hub's time sync");
  expect(steps.steps.map(({ title }) => title)).toEqual([
    "Check the Hub's time sync",
    'Check its time sync',
  ]);
  expect(utc(evidenceNote(skew, NOW) ?? [])).toContain('No Report has');
});

test('update and reboot cards retain the Hub reason and offer manual next steps', () => {
  const pending = attention(
    { kind: 'pending_update', reason: '2 APT packages are out of date.' },
    {
      evidence: 'old',
      level: 'warning',
      subject: '["apt","system"]',
    },
  );
  expect(subjectText(pending)).toBe('APT (system)');
  expect(evidenceWords(pending, NOW).observed).toEqual(['2 APT packages are out of date.']);
  expect(utc(evidenceNote(pending, NOW) ?? [])).toContain('24 hours');
  expect(utc(evidenceNote(pending, NOW) ?? [])).not.toContain('2 hours');
  const reboot = attention(
    { kind: 'reboot_required', reason: 'A reboot is required.' },
    { level: 'note' },
  );
  expect(subjectText(reboot)).toBe('');
  expect(evidenceWords(reboot, NOW).observed).toEqual(['A reboot is required.']);
  expect(nextSteps(reboot)).toMatchObject({ short: 'Plan a reboot', steps: [{ commands: [] }] });
});
