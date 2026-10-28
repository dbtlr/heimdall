import { describe, expect, test } from 'bun:test';

import type { RebootObservation, UpdateManager } from '@heimdall/schema';

import { hotProcessFacts, updateFacts } from './attention.ts';
import type { ConditionRow, Held } from './attention.ts';

const NOW = Date.UTC(2026, 9, 6, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const held = (parts: Partial<Held> = {}): Held => ({
  checks: undefined,
  clockOffsetAt: undefined,
  conditions: [],
  jobRuns: new Map(),
  lastSeenAt: undefined,
  reboot: undefined,
  records: [],
  runSet: undefined,
  sample: undefined,
  sleeps: false,
  updateManagers: [],
  ...parts,
});

const row = (kind: string, subject: string): ConditionRow => ({
  id: '1',
  kind,
  latest_at: new Date(NOW),
  latest_reason: 'the Hub reason',
  level: 'warning',
  raised_at: new Date(NOW - HOUR),
  subject,
  system: 'server-1',
});

const sampleAt = (t: number, process_coverage: unknown) => ({
  sample: {
    cpu_known: true,
    disks: [],
    memory_known: true,
    process_coverage,
    system: 'server-1',
    t: new Date(t),
  },
});

const rebootAvailable = (required: boolean, observedAt = NOW): RebootObservation => ({
  kind: 'available',
  observedAt,
  required,
});

const manager = (
  observedAt: number,
  result: UpdateManager['result'],
  name = 'apt',
): UpdateManager =>
  ({ installation: 'system', manager: name, observedAt, result }) as UpdateManager;
const updatesAvailable = (metadataAt: number | null, count = 1): UpdateManager['result'] => ({
  kind: 'available',
  metadataAt,
  updates: Array.from({ length: count }, () => ({
    available: '2',
    installed: '1',
    name: 'openssl',
    security: null,
  })),
});

describe('hotProcessFacts', () => {
  const SUBJECT = JSON.stringify(['boot-1', 42, '123', 'compiler']);
  const judge = (parts: Partial<Held>) =>
    hotProcessFacts(held(parts), row('hot_process', SUBJECT), NOW);

  test('is current when the newest sample is covered for this process', () => {
    expect(judge(sampleAt(NOW, { [SUBJECT]: true }))).toEqual({
      checkedAt: NOW,
      evidence: 'current',
      facts: { kind: 'hot_process', reason: 'the Hub reason' },
    });
  });

  test('is unknown when coverage names the process uncovered, names another process, or is absent', () => {
    for (const coverage of [{ [SUBJECT]: false }, { other: true }, null, undefined]) {
      expect(judge(sampleAt(NOW, coverage)).evidence).toBe('unknown');
    }
  });

  test('is old when the newest sample is over 2 hours old, covered or not, and at the edge it is not', () => {
    expect(judge(sampleAt(NOW - 2 * HOUR, { [SUBJECT]: true })).evidence).toBe('current');
    expect(judge(sampleAt(NOW - 2 * HOUR - 1, { [SUBJECT]: true })).evidence).toBe('old');
    expect(judge(sampleAt(NOW - 3 * HOUR, { [SUBJECT]: false })).evidence).toBe('old');
  });

  test('is old, with nothing checked, when no sample exists', () => {
    expect(judge({})).toMatchObject({ checkedAt: undefined, evidence: 'old' });
  });
});

const judgeReboot = (reboot: RebootObservation | undefined) =>
  updateFacts(held({ reboot }), row('reboot_required', ''), NOW);

describe('updateFacts for reboot_required', () => {
  test('is current when a fresh observation says a reboot is required, keeping the Hub reason', () => {
    expect(judgeReboot(rebootAvailable(true, NOW - MINUTE))).toEqual({
      checkedAt: NOW - MINUTE,
      evidence: 'current',
      facts: { kind: 'reboot_required', reason: 'the Hub reason' },
    });
  });

  test('is unknown when a fresh observation says no reboot is required or could not be made', () => {
    expect(judgeReboot(rebootAvailable(false)).evidence).toBe('unknown');
    expect(
      judgeReboot({ kind: 'unavailable', observedAt: NOW, reason: 'Permission denied' }).evidence,
    ).toBe('unknown');
  });

  test('is old when the observation is over a day old, none exists, or it is dated beyond the clock tolerance', () => {
    expect(judgeReboot(rebootAvailable(true, NOW - DAY)).evidence).toBe('current');
    expect(judgeReboot(rebootAvailable(true, NOW - DAY - 1)).evidence).toBe('old');
    expect(judgeReboot(undefined)).toMatchObject({ checkedAt: undefined, evidence: 'old' });
    expect(judgeReboot(rebootAvailable(true, NOW + 5 * MINUTE + 1)).evidence).toBe('old');
  });
});

describe('updateFacts for pending_update', () => {
  const SUBJECT = '["apt","system"]';
  const judge = (...updateManagers: UpdateManager[]) =>
    updateFacts(held({ updateManagers }), row('pending_update', SUBJECT), NOW);

  test('is current with updates pending, keeping the Hub reason and the time of the query', () => {
    expect(judge(manager(NOW - HOUR, updatesAvailable(NOW)))).toEqual({
      checkedAt: NOW - HOUR,
      evidence: 'current',
      facts: { kind: 'pending_update', reason: 'the Hub reason' },
    });
  });

  test('is current at the edge of the query age (a day) and of the metadata age (7 days)', () => {
    expect(judge(manager(NOW - DAY, updatesAvailable(NOW))).evidence).toBe('current');
    expect(judge(manager(NOW, updatesAvailable(NOW - 7 * DAY))).evidence).toBe('current');
  });

  test('is old past either edge, with unknown metadata, or for a query dated beyond the clock tolerance', () => {
    expect(judge(manager(NOW - DAY - 1, updatesAvailable(NOW))).evidence).toBe('old');
    expect(judge(manager(NOW, updatesAvailable(NOW - 7 * DAY - 1))).evidence).toBe('old');
    expect(judge(manager(NOW, updatesAvailable(null))).evidence).toBe('old');
    expect(judge(manager(NOW + 5 * MINUTE + 1, updatesAvailable(NOW))).evidence).toBe('old');
  });

  test('is unknown when a fresh query found no updates or could not run', () => {
    expect(judge(manager(NOW, updatesAvailable(NOW, 0))).evidence).toBe('unknown');
    expect(judge(manager(NOW, { kind: 'unavailable', reason: 'no network' })).evidence).toBe(
      'unknown',
    );
  });

  test('is old, with nothing checked, when no manager matches the Condition subject', () => {
    expect(judge()).toMatchObject({ checkedAt: undefined, evidence: 'old' });
    expect(judge(manager(NOW, updatesAvailable(NOW), 'brew'))).toMatchObject({
      checkedAt: undefined,
      evidence: 'old',
    });
  });
});
