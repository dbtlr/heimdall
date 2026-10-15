import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import { filesRecordDigest } from '@heimdall/schema';

import type { Attention, AttentionKind } from './attention-types.ts';
import { readAttention } from './attention.ts';
import { readFleetOverview } from './fleet-overview.ts';
import { readSystemRecords } from './system-detail.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Seconds after NOW, as the Hub's fixtures take them.
const { addCondition } = timeline(NOW);

// Sends one Report from `system` as the Hub receives it at `receivedAt`, with a
// sample at that time and any further sections.
const hear = async (
  h: Hub,
  system: string,
  { receivedAt = NOW, ...sections }: { receivedAt?: number; [section: string]: unknown } = {},
) => {
  h.clock.now = receivedAt;
  const response = await push(
    h.hub,
    { ...report(system, [receivedAt]), ...sections },
    { token: `${system.split('-')[0]}-token` },
  );
  expect(response.status).toBe(200);
};

const WEB = {
  health: 'http://127.0.0.1:8080/health',
  name: 'web',
  supervisor: 'systemd',
  unit: 'web.service',
};
const BACKUP = {
  name: 'backup',
  schedule: [{ hour: 3, minute: 30 }],
  scheduler: 'systemd-timer',
  unit: 'backup.timer',
};
const DOTFILES = {
  files: [
    { path: '/home/someone/.gitconfig', sha256: 'a'.repeat(64) },
    { path: '/home/someone/.zshrc', sha256: 'b'.repeat(64) },
    { path: '/home/someone/.vimrc', sha256: 'c'.repeat(64) },
  ],
  name: 'dotfiles',
};
const ZSHRC = '/home/someone/.zshrc';

const records = {
  records: [
    { kind: 'service', name: 'web', record: WEB },
    { kind: 'job', name: 'backup', record: BACKUP },
    { kind: 'files', name: 'dotfiles', record: DOTFILES },
  ],
  unreadable: [],
};

// A checks section whose files part judges the dotfiles record, naming `files`
// as the files that do not match.
const filesChecks = async (
  files: { path: string; state: 'drifted' | 'missing' | 'unreadable' }[],
) => ({
  fileRecords: [{ digest: await filesRecordDigest(DOTFILES), record: 'dotfiles' }],
  files: files.map(({ path, state }) => ({ path, record: 'dotfiles', since: NOW - HOUR, state })),
});

const serviceCheck = (check: string, state: string, detail = state) => ({
  check,
  detail,
  service: 'web',
  since: NOW - HOUR,
  state,
});

const RUN = { exitStatus: 2, finished: '2026-10-06T03:31:00Z', started: '2026-10-06T03:30:00Z' };
const SUCCESS = {
  exitStatus: 0,
  finished: '2026-10-04T03:31:00Z',
  started: '2026-10-04T03:30:00Z',
};

const runs = (latestSuccess: typeof SUCCESS | null) => ({
  jobs: [{ job: 'backup', latestRun: RUN, latestSuccess }],
  unreadable: [],
});

const PAIRED = [{ name: 'server-1', paired: true }];

const attention = (h: Hub, systems = PAIRED) => readAttention(h.db.sql, { now: NOW, systems });

// The one item of `kind` that attention holds.
const only = async (h: Hub, kind: AttentionKind): Promise<Attention> => {
  const found = (await attention(h)).filter((item) => item.kind === kind);
  expect(found).toHaveLength(1);
  const [item] = found;
  if (item === undefined) {
    throw new Error(`no ${kind} item`);
  }
  return item;
};

test('a hot process keeps its stored level while a newer sample awaits evaluation', async () => {
  await using h = await startHub();
  await hear(h, 'server-1');
  await addCondition(h.db.sql, {
    kind: 'hot_process',
    level: 'warning',
    raisedAt: -3600,
    reason: 'compiler (PID 42) above 0.5 cores for 120 minutes in 240 minutes.',
    subject: JSON.stringify(['boot-1', 42, '123', 'compiler']),
    system: 'server-1',
  });
  expect(await only(h, 'hot_process')).toMatchObject({
    checkedAt: NOW,
    evidence: 'unknown',
    level: 'warning',
    reason: 'compiler (PID 42) above 0.5 cores for 120 minutes in 240 minutes.',
  });
  const fleet = await readFleetOverview(h.db.sql, { now: NOW, range: '6h' });
  expect(fleet.lanes.find(({ name }) => name === 'server-1')).toMatchObject({
    conditions: [{ kind: 'hot_process', level: 'warning' }],
    status: 'needs_you',
  });
  const systemRecords = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });
  expect(systemRecords.timeline).toMatchObject([
    { kind: 'hot_process', level: 'warning', transitions: [{ kind: 'raised', level: 'warning' }] },
  ]);
});

test.each([
  {
    covered: true,
    evidence: 'current',
    label: 'current for this process',
    latest: NOW,
    through: NOW,
  },
  {
    covered: false,
    evidence: 'unknown',
    label: 'unknown for an uncovered process',
    latest: NOW,
    through: NOW,
  },
  {
    covered: true,
    evidence: 'unknown',
    label: 'unknown when coverage predates the sample',
    latest: NOW,
    through: NOW - 15_000,
  },
  {
    covered: true,
    evidence: 'old',
    label: 'old when the newest sample is old',
    latest: NOW - 3 * HOUR,
    through: NOW - 3 * HOUR,
  },
])('hot process evidence is $label', async ({ covered, latest, through, evidence }) => {
  await using h = await startHub();
  await hear(h, 'server-1', { receivedAt: latest });
  const subject = JSON.stringify(['boot-1', 42, '123', 'compiler']);
  await addCondition(h.db.sql, {
    kind: 'hot_process',
    level: 'warning',
    raisedAt: -4 * 3600,
    subject,
    system: 'server-1',
  });
  const coverage = JSON.stringify({
    [subject]: covered,
    [JSON.stringify(['boot-1', 43, '123', 'compiler'])]: true,
  });
  await h.db.sql`
    INSERT INTO hot_process_evaluations (system, through, coverage, limits)
    VALUES ('server-1', ${new Date(through)}, ${coverage}::text::jsonb, '{}'::jsonb)
  `;
  expect(await only(h, 'hot_process')).toMatchObject({
    checkedAt: latest,
    evidence,
    level: 'warning',
  });
});

const drift = (h: Hub, path = ZSHRC) =>
  addCondition(h.db.sql, { kind: 'drift', raisedAt: -3600, subject: path, system: 'server-1' });

describe('readAttention', () => {
  test('reads nothing for no Systems', async () => {
    await using h = await startHub();

    expect(await attention(h, [])).toEqual([]);
  });

  test('reads nothing for a System with nothing open', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { records });

    expect(await attention(h)).toEqual([]);
  });

  test('reads only the Systems it is asked for', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    await addCondition(h.db.sql, { kind: 'low_disk', raisedAt: -60, system: 'laptop-1' });

    expect(await attention(h)).toEqual([]);
  });

  test('reads a cleared Condition as nothing', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      clearedAt: -60,
      kind: 'system_stale',
      raisedAt: -3600,
      system: 'server-1',
    });

    expect(await attention(h)).toEqual([]);
  });
});

describe('Drift', () => {
  test('names the record, the recorded hash, and the files that match, on a current changed check', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: await filesChecks([{ path: ZSHRC, state: 'drifted' }]),
      records,
    });
    await drift(h);

    expect(await only(h, 'drift')).toEqual({
      checkedAt: NOW,
      evidence: 'current',
      firstDetected: NOW - HOUR,
      kind: 'drift',
      level: 'warning',
      othersMatching: 2,
      record: 'dotfiles',
      sha256: 'b'.repeat(64),
      state: 'drifted',
      subject: ZSHRC,
      system: 'server-1',
      unpaired: false,
    });
  });

  test('finds the record by its path when the checks no longer list the file', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { checks: await filesChecks([]), records });
    await drift(h);

    const item = await only(h, 'drift');

    expect(item).toMatchObject({ othersMatching: 2, record: 'dotfiles', state: undefined });
    expect(item.evidence).toBe('current');
  });

  test('has unknown evidence and counts no matching files for a record the checks did not judge', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: {
        fileRecords: [{ digest: 'f'.repeat(64), record: 'dotfiles' }],
        files: [{ path: ZSHRC, record: 'dotfiles', since: NOW - HOUR, state: 'drifted' }],
      },
      records,
    });
    await drift(h);

    expect(await only(h, 'drift')).toMatchObject({
      evidence: 'unknown',
      othersMatching: 0,
      record: 'dotfiles',
    });
  });

  test('has unknown evidence when the latest checks carried no files part', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: { services: [serviceCheck('supervisor', 'up')] },
      records,
    });
    await drift(h);

    expect(await only(h, 'drift')).toMatchObject({ evidence: 'unknown', state: undefined });
  });

  test('has unknown evidence when the file is now unreadable', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: await filesChecks([{ path: ZSHRC, state: 'unreadable' }]),
      records,
    });
    await drift(h);

    expect(await only(h, 'drift')).toMatchObject({ evidence: 'unknown', state: 'unreadable' });
  });

  test('has old evidence when its check set arrived over 2 hours ago', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: await filesChecks([{ path: ZSHRC, state: 'drifted' }]),
      receivedAt: NOW - 3 * HOUR,
      records,
    });
    await drift(h);

    expect(await only(h, 'drift')).toMatchObject({
      checkedAt: NOW - 3 * HOUR,
      evidence: 'old',
    });
  });

  test('has old evidence when no check set ever arrived', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await drift(h);

    expect(await only(h, 'drift')).toMatchObject({
      checkedAt: undefined,
      evidence: 'old',
      record: undefined,
    });
  });
});

describe('Service down', () => {
  test('lists the Service checks, supervisor first, with what names it to its supervisor', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: {
        services: [
          serviceCheck('health', 'unhealthy', 'HTTP 503'),
          serviceCheck('supervisor', 'stopped', 'ActiveState=failed'),
        ],
      },
      records,
    });
    await addCondition(h.db.sql, {
      kind: 'service_down',
      raisedAt: -3600,
      reason: 'web is stopped',
      subject: 'web',
      system: 'server-1',
    });

    expect(await only(h, 'service_down')).toMatchObject({
      checkedAt: NOW,
      checks: [
        { check: 'supervisor', detail: 'ActiveState=failed', since: NOW - HOUR, state: 'stopped' },
        { check: 'health', detail: 'HTTP 503', since: NOW - HOUR, state: 'unhealthy' },
      ],
      evidence: 'current',
      reason: 'web is stopped',
      service: {
        health: 'http://127.0.0.1:8080/health',
        supervisor: 'systemd',
        target: 'web.service',
      },
    });
  });

  test('has unknown evidence when the checks now say unknown', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: { services: [serviceCheck('supervisor', 'unknown')] },
      records,
    });
    await addCondition(h.db.sql, {
      kind: 'service_down',
      raisedAt: -3600,
      subject: 'web',
      system: 'server-1',
    });

    expect(await only(h, 'service_down')).toMatchObject({ evidence: 'unknown' });
  });

  test('has old evidence when its checks arrived over 2 hours ago', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: { services: [serviceCheck('supervisor', 'stopped')] },
      receivedAt: NOW - 3 * HOUR,
      records,
    });
    await addCondition(h.db.sql, {
      kind: 'service_down',
      raisedAt: -3600,
      subject: 'web',
      system: 'server-1',
    });

    expect(await only(h, 'service_down')).toMatchObject({ evidence: 'old' });
  });

  test('names no supervisor target for a Service the Hub does not mirror', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { checks: { services: [serviceCheck('supervisor', 'stopped')] } });
    await addCondition(h.db.sql, {
      kind: 'service_down',
      raisedAt: -3600,
      subject: 'web',
      system: 'server-1',
    });

    expect(await only(h, 'service_down')).toMatchObject({ service: undefined });
  });
});

describe('job Conditions', () => {
  test('gives a failing job its latest run and what names it to its scheduler', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { records, runs: runs(null) });
    await addCondition(h.db.sql, {
      kind: 'job_failing',
      raisedAt: -3600,
      subject: 'backup',
      system: 'server-1',
    });

    expect(await only(h, 'job_failing')).toMatchObject({
      checkedAt: NOW,
      evidence: 'current',
      job: { scheduler: 'systemd-timer', target: 'backup.timer' },
      latestRun: {
        exitStatus: 2,
        finished: Date.parse(RUN.finished),
        started: Date.parse(RUN.started),
      },
    });
  });

  test('gives an overdue job its latest success and schedule', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { records, runs: runs(SUCCESS) });
    await addCondition(h.db.sql, {
      kind: 'job_overdue',
      raisedAt: -3600,
      reason: 'backup is 2 days overdue',
      subject: 'backup',
      system: 'server-1',
    });

    expect(await only(h, 'job_overdue')).toMatchObject({
      job: { scheduler: 'systemd-timer', target: 'backup.timer' },
      latestSuccess: {
        exitStatus: 0,
        finished: Date.parse(SUCCESS.finished),
        started: Date.parse(SUCCESS.started),
      },
      reason: 'backup is 2 days overdue',
      schedule: [{ hour: 3, minute: 30 }],
    });
  });

  test('gives an overdue job that never succeeded no latest success', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { records, runs: runs(null) });
    await addCondition(h.db.sql, {
      kind: 'job_overdue',
      raisedAt: -3600,
      subject: 'backup',
      system: 'server-1',
    });

    expect(await only(h, 'job_overdue')).toMatchObject({ latestSuccess: undefined });
  });

  test('has old evidence when the run set arrived over 2 hours ago', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { receivedAt: NOW - 3 * HOUR, records, runs: runs(null) });
    await addCondition(h.db.sql, {
      kind: 'job_failing',
      raisedAt: -3600,
      subject: 'backup',
      system: 'server-1',
    });

    expect(await only(h, 'job_failing')).toMatchObject({
      checkedAt: NOW - 3 * HOUR,
      evidence: 'old',
    });
  });

  test('names no job for one the Hub does not mirror', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      kind: 'job_overdue',
      raisedAt: -3600,
      subject: 'backup',
      system: 'server-1',
    });

    expect(await only(h, 'job_overdue')).toMatchObject({ job: undefined, schedule: [] });
  });
});

describe('System Conditions', () => {
  test('gives low disk the mount from the newest Vitals', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      raisedAt: -3600,
      reason: 'the disk is 90% full',
      subject: '/System/Volumes/Data',
      system: 'server-1',
    });

    expect(await only(h, 'low_disk')).toMatchObject({
      checkedAt: NOW,
      disk: {
        mount: '/System/Volumes/Data',
        totalBytes: 994_662_584_320,
        usedBytes: 412_316_860_416,
      },
      evidence: 'current',
      reason: 'the disk is 90% full',
    });
  });

  test('has old evidence for low disk when the newest Vitals are over 2 hours old', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { receivedAt: NOW - 3 * HOUR });
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      raisedAt: -4 * 3600,
      subject: '/System/Volumes/Data',
      system: 'server-1',
    });

    expect(await only(h, 'low_disk')).toMatchObject({ checkedAt: NOW - 3 * HOUR, evidence: 'old' });
  });

  test('gives low disk no disk when the newest Vitals lack the mount', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      raisedAt: -3600,
      subject: '/gone',
      system: 'server-1',
    });

    expect(await only(h, 'low_disk')).toMatchObject({ checkedAt: NOW, disk: undefined });
  });

  test('checks a stale System when it was last seen', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { receivedAt: NOW - 3 * HOUR });
    await addCondition(h.db.sql, {
      kind: 'system_stale',
      raisedAt: -60,
      reason: 'no Report for 3 hours',
      system: 'server-1',
    });

    expect(await only(h, 'system_stale')).toMatchObject({
      checkedAt: NOW - 3 * HOUR,
      evidence: 'current',
      lastSeenAt: NOW - 3 * HOUR,
      reason: 'no Report for 3 hours',
      sleeps: false,
    });
  });

  test('checks rejected Reports when the latest was rejected', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      kind: 'reports_rejected',
      raisedAt: -3600,
      reason: 'schema version 9 is not supported',
      system: 'server-1',
    });
    await h.db.sql`UPDATE conditions SET latest_at = ${new Date(NOW - MINUTE)}`;

    expect(await only(h, 'reports_rejected')).toMatchObject({
      checkedAt: NOW - MINUTE,
      evidence: 'current',
      reason: 'schema version 9 is not supported',
    });
  });
});

describe('unreadable files', () => {
  test('lists an unreadable file of a record the checks judged', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: await filesChecks([{ path: ZSHRC, state: 'unreadable' }]),
      records,
    });

    expect(await attention(h)).toEqual([
      {
        checkedAt: NOW,
        evidence: 'unknown',
        firstDetected: NOW - HOUR,
        kind: 'file_unreadable',
        record: 'dotfiles',
        sha256: 'b'.repeat(64),
        subject: ZSHRC,
        system: 'server-1',
        unpaired: false,
      },
    ]);
  });

  test('has old evidence when the check set arrived over 2 hours ago', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: await filesChecks([{ path: ZSHRC, state: 'unreadable' }]),
      receivedAt: NOW - 3 * HOUR,
      records,
    });

    expect(await only(h, 'file_unreadable')).toMatchObject({ evidence: 'old' });
  });

  test('lists no file of a record the checks did not judge', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: {
        fileRecords: [{ digest: 'f'.repeat(64), record: 'dotfiles' }],
        files: [{ path: ZSHRC, record: 'dotfiles', since: NOW - HOUR, state: 'unreadable' }],
      },
      records,
    });

    expect(await attention(h)).toEqual([]);
  });

  test('lists no file that matches or drifts', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: await filesChecks([{ path: ZSHRC, state: 'drifted' }]),
      records,
    });

    expect(await attention(h)).toEqual([]);
  });

  test('lists no file an open Drift Condition covers', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: await filesChecks([{ path: ZSHRC, state: 'unreadable' }]),
      records,
    });
    await drift(h);

    expect((await attention(h)).map(({ kind }) => kind)).toEqual(['drift']);
  });
});

describe('missing checks and runs', () => {
  test('flags checks that stopped arriving while the System kept reporting', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: { services: [serviceCheck('supervisor', 'up')] },
      receivedAt: NOW - 3 * HOUR,
      records,
    });
    await hear(h, 'server-1');

    expect(await attention(h)).toEqual([
      {
        checkedAt: NOW - 3 * HOUR,
        evidence: 'old',
        firstDetected: NOW - HOUR,
        kind: 'checks_missing',
        set: 'checks',
        subject: '',
        system: 'server-1',
        unpaired: false,
      },
    ]);
  });

  test('flags runs that stopped arriving while the System kept reporting', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { receivedAt: NOW - 3 * HOUR, records, runs: runs(null) });
    await hear(h, 'server-1');

    expect(await only(h, 'checks_missing')).toMatchObject({
      checkedAt: NOW - 3 * HOUR,
      firstDetected: NOW - HOUR,
      set: 'runs',
    });
  });

  test('flags nothing when the System reported within 2 hours of its checks', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: { services: [serviceCheck('supervisor', 'up')] },
      receivedAt: NOW - HOUR,
      records,
      runs: runs(null),
    });
    await hear(h, 'server-1');

    expect(await attention(h)).toEqual([]);
  });

  test('flags nothing for a System with nothing recorded that checks would judge', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: { services: [] },
      receivedAt: NOW - 3 * HOUR,
      records: { records: [], unreadable: [] },
    });
    await hear(h, 'server-1');

    expect(await attention(h)).toEqual([]);
  });

  test('flags nothing for a System that never sent checks', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { records });

    expect(await attention(h)).toEqual([]);
  });
});

describe('order', () => {
  test('puts the newest first detected first and items on unpaired Systems last', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    await addCondition(h.db.sql, { kind: 'low_disk', raisedAt: -7200, system: 'server-1' });
    await addCondition(h.db.sql, { kind: 'system_stale', raisedAt: -60, system: 'server-1' });
    await addCondition(h.db.sql, { kind: 'system_stale', raisedAt: -30, system: 'laptop-1' });

    const items = await attention(h, [
      { name: 'laptop-1', paired: false },
      { name: 'server-1', paired: true },
    ]);

    expect(items.map(({ kind, system, unpaired }) => [kind, system, unpaired])).toEqual([
      ['system_stale', 'server-1', false],
      ['low_disk', 'server-1', false],
      ['system_stale', 'laptop-1', true],
    ]);
  });
});
