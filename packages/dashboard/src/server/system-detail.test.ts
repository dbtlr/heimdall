import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, storeToken, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import { filesRecordDigest } from '@heimdall/schema';

import {
  parseDetailInput,
  parseSampleInput,
  readSample,
  readSystemDetail,
  readSystemPage,
  readSystemRecords,
} from './system-detail.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BUCKET = 5 * MINUTE;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

// Seconds after NOW, as the Hub's fixtures take them.
const { addCondition, addProcess, addSession } = timeline(NOW);

test('System navigation lists paired Systems with Hub health and keeps the current unpaired System', async () => {
  await using h = await startHub();
  await hear(h, 'server-1');
  await hear(h, 'laptop-1');
  await addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'note',
    raisedAt: -60,
    subject: '/',
    system: 'laptop-1',
  });
  await addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'alert',
    raisedAt: -60,
    subject: '/',
    system: 'server-1',
  });
  const page = await readSystemPage(h.db.sql, { name: 'server-1', now: NOW, range: '12h' });
  expect(page?.navigation).toEqual([
    { level: undefined, name: 'laptop-1', status: 'up' },
    { level: 'alert', name: 'server-1', status: 'needs_you' },
  ]);
  await unpair(h.db.sql, 'server-1');
  const retained = await readSystemPage(h.db.sql, { name: 'server-1', now: NOW, range: '12h' });
  expect(retained?.navigation).toEqual([
    { level: undefined, name: 'laptop-1', status: 'up' },
    { level: 'alert', name: 'server-1', status: 'unpaired' },
  ]);
  const other = await readSystemPage(h.db.sql, { name: 'laptop-1', now: NOW, range: '12h' });
  expect(other?.navigation.map(({ name }) => name)).toEqual(['laptop-1']);
});

test('a System page keeps health, history, and attention in one snapshot during a concurrent level change', async () => {
  await using h = await startHub();
  await hear(h, 'server-1');
  const occurrence = await addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'note',
    raisedAt: -600,
    subject: '/',
    system: 'server-1',
  });
  const writer = await h.db.sql.reserve();
  await writer.unsafe('BEGIN');
  await writer.unsafe('LOCK TABLE vitals_rollups IN ACCESS EXCLUSIVE MODE');
  let writing = true;
  const input = { name: 'server-1', now: NOW, range: '12h' as const };
  const pending = readSystemPage(h.db.sql, input);
  try {
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (!blocked && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- observe the real reader reaching the gate.
      const rows: { blocked: boolean }[] = await h.db.sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM vitals_rollups%'
        ) AS blocked
      `;
      blocked = rows[0]?.blocked === true;
      if (!blocked) {
        // oxlint-disable-next-line no-await-in-loop -- bounded wait for another connection.
        await Bun.sleep(10);
      }
    }
    expect(blocked).toBe(true);
    await writer`SELECT 1 FROM systems WHERE name = 'server-1' FOR UPDATE`;
    await writer`UPDATE conditions SET level = 'alert', latest_reason = '90% used' WHERE id = ${occurrence}`;
    await writer`
      INSERT INTO condition_transitions (condition, action, level, previous_level, at, reason)
      VALUES (${occurrence}, 'level_changed', 'alert', 'note', ${new Date(NOW)}, '90% used')
    `;
    await writer.unsafe('COMMIT');
    writing = false;
    const page = await pending;
    expect(page?.detail.status).toBe('up');
    expect(page?.detail.conditions[0]?.level).toBe('note');
    expect(page?.records.timeline[0]?.transitions.map(({ level }) => level)).toEqual(['note']);
    expect(page?.attention[0]?.level).toBe('note');

    const fresh = await readSystemPage(h.db.sql, input);
    expect(fresh?.detail.status).toBe('needs_you');
    expect(fresh?.detail.conditions[0]?.level).toBe('alert');
    expect(fresh?.records.timeline[0]?.transitions.map(({ level }) => level)).toEqual([
      'note',
      'alert',
    ]);
    expect(fresh?.attention[0]?.level).toBe('alert');
  } finally {
    if (writing) {
      await writer.unsafe('ROLLBACK');
    }
    writer.release();
    await pending;
  }
});

// The times of a sample every 15 seconds from `from` until before `to`, in
// seconds after NOW.
const every15s = (from: number, to: number) =>
  Array.from({ length: Math.floor((to - from) / 15) }, (_, i) => NOW + (from + i * 15) * SECOND);

// Sends one Report from `system` as the Hub receives it at NOW, with samples at
// `times` and any further sections.
const hear = async (
  h: Hub,
  system: string,
  { times = [NOW], ...sections }: { times?: number[]; [section: string]: unknown } = {},
) => {
  h.clock.now = NOW;
  const response = await push(
    h.hub,
    { ...report(system, times), ...sections },
    { token: `${system.split('-')[0]}-token` },
  );
  expect(response.status).toBe(200);
};

const price = (h: Hub) => h.db.sql`
  INSERT INTO model_prices (
    model, valid_from, source, input_per_mtok, output_per_mtok, context_window
  )
  VALUES ('priced-model', '2020-01-01', 'bundled', 1000000, 2000000, 100000)
`;

const detail = async (h: Hub, name = 'server-1', range: '12h' | '24h' | '6h' | '7d' = '12h') => {
  const found = await readSystemDetail(h.db.sql, { name, now: NOW, range });
  if (found === undefined) {
    throw new Error(`no detail for ${name}`);
  }
  return found;
};

describe('parseDetailInput', () => {
  test('takes the System and range, and opens on 12 hours', () => {
    expect(parseDetailInput({ name: 'server-1', range: '7d' })).toEqual({
      name: 'server-1',
      range: '7d',
    });
    expect(parseDetailInput({ name: 'server-1' })).toEqual({ name: 'server-1', range: '12h' });
  });

  test('refuses a missing System or a range that is not offered', () => {
    expect(() => parseDetailInput({ range: '12h' })).toThrow('System');
    expect(() => parseDetailInput({ name: 'server-1', range: '3d' })).toThrow('3d');
  });
});

describe('parseSampleInput', () => {
  test('takes the System and the time asked for, which may be left out', () => {
    expect(parseSampleInput({ at: 5, name: 'server-1' })).toEqual({ at: 5, name: 'server-1' });
    expect(parseSampleInput({ name: 'server-1' })).toEqual({ at: undefined, name: 'server-1' });
  });

  test('refuses a time that is not a number', () => {
    expect(() => parseSampleInput({ at: 'noon', name: 'server-1' })).toThrow('noon');
  });
});

describe('readSystemDetail', () => {
  test('answers nothing for a name that is no System at all', async () => {
    await using h = await startHub();

    expect(
      await readSystemDetail(h.db.sql, {
        name: 'nobody-1',
        now: NOW,
        range: '12h',
      }),
    ).toBeUndefined();
  });

  test('describes the System from its newest Report: platform, uptime, and installed Harnesses', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      harnesses: {
        installs: [
          { harness: 'codex', location: 'npm', version: '0.163.0' },
          { harness: 'claude-code', location: 'native', version: '2.4.1' },
        ],
      },
      times: [NOW - MINUTE, NOW],
    });

    const found = await detail(h);

    expect(found).toMatchObject({
      harnesses: [
        { harness: 'claude-code', location: 'native', version: '2.4.1' },
        { harness: 'codex', location: 'npm', version: '0.163.0' },
      ],
      lastSeenAt: NOW,
      latest: {
        cpuBusyPercent: 23.4,
        memoryTotalBytes: 34_359_738_368,
        memoryUsedBytes: 12_884_901_888,
        t: NOW,
        uptimeSeconds: 86_400,
      },
      name: 'server-1',
      platform: { arch: 'arm64', os: 'darwin' },
      status: 'up',
    });
    expect(found.from).toBe(NOW - 12 * HOUR);
  });

  test('carries the facts the Collector reported: its version, load, disks, and Harness installs with their location', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      harnesses: {
        installs: [
          { harness: 'codex', location: 'npm', version: '0.163.0' },
          { harness: 'claude-code', location: 'native', version: '2.4.1' },
        ],
      },
    });

    const found = await detail(h);

    expect(found.collectorVersion).toBe('0.1.0');
    expect(found.latest).toMatchObject({
      disks: [
        { mount: '/System/Volumes/Data', totalBytes: 994_662_584_320, usedBytes: 412_316_860_416 },
      ],
      load: [1.2, 0.9, 0.7],
    });
    expect(found.harnesses).toEqual([
      { harness: 'claude-code', location: 'native', version: '2.4.1' },
      { harness: 'codex', location: 'npm', version: '0.163.0' },
    ]);
  });

  test('tells a Collector that reported no Harnesses from one that never reported them', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { harnesses: { installs: [] } });
    await hear(h, 'laptop-1');

    expect((await detail(h, 'server-1')).harnesses).toEqual([]);
    expect((await detail(h, 'laptop-1')).harnesses).toBeUndefined();
  });

  test('has no facts for a System the Hub has not heard from', async () => {
    await using h = await startHub();

    const found = await detail(h, 'laptop-1');

    expect(found).toMatchObject({
      collectorVersion: undefined,
      harnesses: undefined,
      paired: true,
    });
    expect(found.latest).toBeUndefined();
  });

  test('carries CPU and memory per 5-minute bucket, and the buckets with no Vitals', async () => {
    await using h = await startHub();
    // Samples for the last hour but for a 10-minute hole 30 minutes ago.
    await hear(h, 'server-1', {
      times: every15s(-3600, 0).filter((t) => t < NOW - 30 * MINUTE || t >= NOW - 20 * MINUTE),
    });

    const found = await detail(h, 'server-1', '6h');

    expect(found.cpu[0]).toMatchObject({ high: 23.4, low: 23.4, t: NOW - HOUR });
    expect(found.cpu[0]?.average).toBeCloseTo(23.4, 9);
    expect(found.memory[0]).toEqual({
      t: NOW - HOUR,
      totalBytes: 34_359_738_368,
      usedBytes: 12_884_901_888,
    });
    expect(found.gaps).toContainEqual({ from: NOW - 30 * MINUTE, to: NOW - 20 * MINUTE });
  });

  test('labels a process in a linked worktree with its repository, in the history and at a sample', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });
    await addProcess(h.db.sql, {
      cpuCores: 1,
      cwd: '/srv/trees/feature',
      end: -1000,
      pid: 10,
      repository: '/srv/work/api',
      start: -4000,
      system: 'server-1',
    });

    const { processes } = await detail(h);
    const sampled = (await inspect(h, NOW - 2490_000)).processes;

    expect(processes[0]?.project).toBe('api');
    expect(sampled[0]?.project).toBe('api');
  });

  test('gives each Harness process the CPU cores it used per bucket', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    await addProcess(h.db.sql, {
      cpuCores: 1.5,
      cwd: '/srv/work/api',
      end: -1000,
      pid: 10,
      start: -4000,
      system: 'server-1',
    });
    await addProcess(h.db.sql, { end: -1000, pid: 11, start: -4000, system: 'laptop-1' });

    const { processes } = await detail(h);

    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ harness: 'claude-code', pid: 10, project: 'api' });
    const cores = processes[0]?.points.map((point) => point.cores) ?? [];
    expect(cores.length).toBeGreaterThan(8);
    for (const value of cores) {
      expect(value).toBeCloseTo(1.5, 5);
    }
  });

  test('has no cores for a bucket with a single reading', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    // Seen at -600 and then only at -10: the bucket holding -10 has one reading.
    await addProcess(h.db.sql, {
      cpuCores: 1,
      end: -10,
      pid: 10,
      seenFrom: -600,
      seenTo: -10,
      start: -600,
      system: 'server-1',
    });
    await h.db.sql`
      DELETE FROM harness_process_samples
      WHERE t > ${new Date(NOW - 400 * SECOND)} AND t < ${new Date(NOW - 10 * SECOND)}
    `;

    const points = (await detail(h)).processes[0]?.points ?? [];

    expect(points.at(-1)).toEqual({ cores: null, t: Math.floor((NOW - 10_000) / BUCKET) * BUCKET });
  });

  test('stacks one row per Session, with each of its stretches and its cost', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await price(h);
    await addProcess(h.db.sql, {
      cwd: '/srv/work/api',
      end: -5000,
      pid: 10,
      start: -9000,
      system: 'server-1',
    });
    await addProcess(h.db.sql, {
      cwd: '/srv/work/api',
      end: -1000,
      pid: 12,
      start: -4000,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      gitBranch: 'feature/detail',
      id: 's1',
      lastCwd: '/srv/work/api',
      model: 'priced-model',
      requests: [-8500, -6000, -3500, -2000],
      system: 'server-1',
    });
    await addSession(h.db.sql, { id: 's2', requests: [-700, -600], system: 'server-1' });

    const { sessions } = await detail(h);

    expect(sessions.map(({ sessionId }) => sessionId)).toEqual(['s1', 's2']);
    expect(sessions[0]).toEqual({
      branch: 'feature/detail',
      costUsd: 20,
      harness: 'claude-code',
      project: 'api',
      sessionId: 's1',
      source: 'claude-code',
      stretches: [
        { endedAt: NOW - 6000_000, link: 'linked', startedAt: NOW - 8500_000 },
        { endedAt: NOW - 2000_000, link: 'linked', startedAt: NOW - 3500_000 },
      ],
    });
    expect(sessions[1]).toMatchObject({ costUsd: undefined, sessionId: 's2' });
  });

  test('keeps two Sessions with one Harness and id but different sources apart', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addSession(h.db.sql, { id: 's1', requests: [-700, -600], system: 'server-1' });
    await addSession(h.db.sql, {
      id: 's1',
      requests: [-500, -400],
      source: 'other',
      system: 'server-1',
    });

    const { sessions } = await detail(h);

    expect(sessions.map(({ sessionId, source }) => [sessionId, source])).toEqual([
      ['s1', 'claude-code'],
      ['s1', 'other'],
    ]);
  });

  test('marks every Condition open during the range, raised before it or not', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      kind: 'drift',
      raisedAt: -2 * 86_400,
      subject: '/etc/a',
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      clearedAt: -3600,
      kind: 'service_down',
      raisedAt: -4000,
      subject: 'web',
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      clearedAt: -86_400,
      kind: 'low_disk',
      raisedAt: -90_000,
      subject: '/',
      system: 'server-1',
    });

    const { conditions } = await detail(h);

    expect(conditions).toMatchObject([
      {
        clearedAt: undefined,
        kind: 'drift',
        level: 'warning',
        raisedAt: NOW - 2 * DAY,
        subject: '/etc/a',
      },
      {
        clearedAt: NOW - HOUR,
        kind: 'service_down',
        level: 'alert',
        raisedAt: NOW - 4000_000,
        subject: 'web',
      },
    ]);
  });
});

// server-1 sends a sample every 15 seconds for the last hour. Process 10 runs
// Session s1 in /srv/work/api; processes 20 and 21 share /srv/work/web, so
// Session s2 there is ambiguous.
const scene = async (h: Hub) => {
  await hear(h, 'server-1', { times: every15s(-3600, 0) });
  await addProcess(h.db.sql, {
    cpuCores: 2,
    cwd: '/srv/work/api',
    end: -1000,
    pid: 10,
    rssBytes: GIB,
    start: -4000,
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    gitBranch: 'main',
    id: 's1',
    lastCwd: '/srv/work/api',
    requests: [-3500, -2500, -2490, -2000],
    system: 'server-1',
  });
  for (const pid of [20, 21]) {
    // oxlint-disable-next-line no-await-in-loop -- two fixture rows.
    await addProcess(h.db.sql, {
      cwd: '/srv/work/web',
      end: -1000,
      pid,
      start: -4000,
      system: 'server-1',
    });
  }
  await addSession(h.db.sql, {
    firstCwd: '/srv/work/web',
    id: 's2',
    requests: [-3000, -2490, -1500],
    system: 'server-1',
  });
};

const inspect = async (h: Hub, at: number | undefined) => {
  const found = await readSample(h.db.sql, { at, name: 'server-1' });
  if (found === undefined) {
    throw new Error('no sample');
  }
  return found;
};

describe('an unpaired System', () => {
  test('keeps its history and reads as Unpaired, with the Conditions it left open', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1', { times: [NOW - 10 * MINUTE, NOW - 9 * MINUTE] });
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      raisedAt: -3600,
      reason: 'disk 95% full',
      subject: '/',
      system: 'laptop-1',
    });
    await unpair(h.db.sql, 'laptop-1');

    const found = await detail(h, 'laptop-1');

    expect(found).toMatchObject({
      collectorVersion: '0.1.0',
      lastSeenAt: NOW,
      latest: { t: NOW - 9 * MINUTE },
      name: 'laptop-1',
      paired: false,
      platform: { arch: 'arm64', os: 'darwin' },
      status: 'unpaired',
    });
    expect(found.cpu).toHaveLength(1);
    expect(found.conditions).toMatchObject([
      {
        clearedAt: undefined,
        kind: 'low_disk',
        level: 'alert',
        raisedAt: NOW - 3600_000,
        subject: '/',
      },
    ]);
  });

  test('keeps its Timeline', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1');
    await addCondition(h.db.sql, {
      clearedAt: -600,
      kind: 'system_stale',
      raisedAt: -1800,
      reason: 'Not heard from.',
      system: 'laptop-1',
    });
    await unpair(h.db.sql, 'laptop-1');

    const { timeline: entries } = await readSystemRecords(h.db.sql, { name: 'laptop-1', now: NOW });

    expect(entries.map(({ kind, reason }) => [kind, reason])).toEqual([
      ['system_stale', 'Not heard from.'],
    ]);
  });

  test('is paired again once a new code is redeemed', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1');
    await unpair(h.db.sql, 'laptop-1');
    expect((await detail(h, 'laptop-1')).paired).toBe(false);

    await storeToken(h.db.sql, { pairedAt: NOW, system: 'laptop-1', token: 'laptop-token' });

    expect(await detail(h, 'laptop-1')).toMatchObject({ paired: true, status: 'up' });
  });
});

const silence = (h: Hub, until: number) =>
  h.db.sql`
    INSERT INTO silences (system, until, created_at)
    VALUES ('server-1', ${new Date(until)}, ${new Date(NOW - HOUR)})
  `;

describe('a silence', () => {
  test('is carried while it holds, and changes nothing else', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    const { silencedUntil: none, ...before } = await detail(h);
    expect(none).toBeUndefined();

    await silence(h, NOW + 2 * HOUR);
    const { silencedUntil, ...silenced } = await detail(h);

    expect(silencedUntil).toBe(NOW + 2 * HOUR);
    expect(silenced).toEqual(before);
  });

  test('is ignored once it ends, though the row remains', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await silence(h, NOW);

    expect((await detail(h)).silencedUntil).toBeUndefined();
  });
});

describe('readSample', () => {
  test('snaps to the sample nearest the time asked for, and the newest when none is', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });

    expect((await inspect(h, NOW - 2496_000)).t).toBe(NOW - 2490_000);
    expect((await inspect(h, NOW - 2480_000)).t).toBe(NOW - 2475_000);
    expect((await inspect(h, undefined)).t).toBe(NOW - 15_000);
    expect((await inspect(h, NOW + DAY)).t).toBe(NOW - 15_000);
  });

  test('answers nothing for a System with no samples', async () => {
    await using h = await startHub();

    expect(await readSample(h.db.sql, { at: undefined, name: 'server-1' })).toBeUndefined();
  });

  test('carries the sample and its bucket: CPU, memory, and load', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });

    const found = await inspect(h, NOW - 2490_000);

    expect(found.bucket?.average).toBeCloseTo(23.4, 9);
    expect(found).toMatchObject({
      bucket: { high: 23.4 },
      cpuBusyPercent: 23.4,
      load1: 1.2,
      memoryTotalBytes: 34_359_738_368,
      memoryUsedBytes: 12_884_901_888,
    });
  });

  test('lists each process running then, its cores and memory, its Session, and the requests it answered', async () => {
    await using h = await startHub();
    await scene(h);

    const { processes } = await inspect(h, NOW - 2490_000);

    expect(processes.map(({ pid }) => pid)).toEqual([10, 20, 21]);
    expect(processes[0]).toMatchObject({
      harness: 'claude-code',
      pid: 10,
      project: 'api',
      // Its requests at -2500 and -2490 fall in the sample's 15 seconds.
      requests: 2,
      rssBytes: GIB,
      sessions: [{ branch: 'main', project: 'api' }],
    });
    expect(processes[0]?.cores).toBeCloseTo(2, 5);
    expect(processes[1]).toMatchObject({
      pid: 20,
      project: 'web',
      requests: 0,
      sessions: [],
    });
  });

  test("names a process's Session by the repository its working directory belongs to", async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });
    await addProcess(h.db.sql, {
      cwd: '/srv/trees/feature',
      end: -1000,
      pid: 10,
      repository: '/srv/work/api',
      start: -4000,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/trees/feature',
      requests: [-3500, -2500, -2490, -2000],
      system: 'server-1',
    });

    const { processes } = await inspect(h, NOW - 2490_000);

    expect(processes[0]?.sessions).toEqual([{ branch: undefined, project: 'api' }]);
  });

  test('lists a Session working then that no single process is linked to', async () => {
    await using h = await startHub();
    await scene(h);

    const { unlinked } = await inspect(h, NOW - 2490_000);

    expect(unlinked).toEqual([
      {
        branch: undefined,
        candidates: 2,
        harness: 'claude-code',
        link: 'ambiguous',
        project: 'web',
        requests: 1,
        sessionId: 's2',
      },
    ]);
  });

  test('names a Session no single process is linked to by its repository', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });
    for (const pid of [20, 21]) {
      // oxlint-disable-next-line no-await-in-loop -- two fixture rows.
      await addProcess(h.db.sql, {
        cwd: '/srv/trees/feature',
        end: -1000,
        pid,
        repository: '/srv/work/web',
        start: -4000,
        system: 'server-1',
      });
    }
    await addSession(h.db.sql, {
      firstCwd: '/srv/trees/feature',
      id: 's2',
      requests: [-3000, -2490, -1500],
      system: 'server-1',
    });

    const { unlinked } = await inspect(h, NOW - 2490_000);

    expect(unlinked.map(({ project }) => project)).toEqual(['web']);
  });

  test('names the Session a process answered requests for in the sample after its last one', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });
    await addProcess(h.db.sql, { cwd: '/srv/work/api', pid: 10, start: -4000, system: 'server-1' });
    await addSession(h.db.sql, {
      gitBranch: 'main',
      id: 's1',
      lastCwd: '/srv/work/api',
      requests: [-40, -20],
      system: 'server-1',
    });

    const { processes } = await inspect(h, undefined);

    expect(processes[0]).toMatchObject({
      requests: 1,
      sessions: [{ branch: 'main', project: 'api' }],
    });
  });

  test('names every Session a process ran at the sample', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });
    await addProcess(h.db.sql, { cwd: '/srv/work/api', pid: 10, start: -4000, system: 'server-1' });
    await addSession(h.db.sql, {
      gitBranch: 'a',
      id: 's1',
      lastCwd: '/srv/work/api',
      requests: [-3000, -2000],
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      gitBranch: 'b',
      id: 's2',
      lastCwd: '/srv/work/api',
      requests: [-2800, -2200],
      system: 'server-1',
    });

    const { processes } = await inspect(h, NOW - 2490_000);

    expect(processes[0]?.sessions.map(({ branch }) => branch).toSorted()).toEqual(['a', 'b']);
  });

  test('counts the requests of an unlinked stretch that ended within the sample', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: every15s(-3600, 0) });
    await addSession(h.db.sql, { id: 's3', requests: [-1210, -1205], system: 'server-1' });

    const { unlinked } = await inspect(h, NOW - 1200_000);

    expect(unlinked).toMatchObject([{ link: 'unmatched', requests: 2, sessionId: 's3' }]);
  });

  test('leaves out processes that had ended and Sessions that were idle', async () => {
    await using h = await startHub();
    await scene(h);

    const found = await inspect(h, NOW - 600_000);

    expect(found.processes).toEqual([]);
    expect(found.unlinked).toEqual([]);
  });
});

describe('readSystemRecords', () => {
  const WEB = { name: 'web', supervisor: 'systemd', unit: 'web.service' };
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
  const NEOVIM = {
    name: 'neovim',
    provenance: { by: 'fleet', revision: 'a1b2c3d' },
    source: 'mise',
    version: '0.12.1',
  };

  const records = {
    records: [
      { kind: 'service', name: 'web', record: WEB },
      { kind: 'job', name: 'backup', record: BACKUP },
      { kind: 'files', name: 'dotfiles', record: DOTFILES },
      { kind: 'application', name: 'neovim', record: NEOVIM },
    ],
    unreadable: [],
  };

  test('reads each recorded Service with its checks', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: {
        services: [
          {
            check: 'supervisor',
            detail: 'ActiveState=active',
            service: 'web',
            since: NOW - DAY,
            state: 'up',
          },
          {
            check: 'health',
            detail: 'HTTP 503',
            service: 'web',
            since: NOW - HOUR,
            state: 'unhealthy',
          },
        ],
      },
      records,
    });

    const { recorded } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });

    expect(recorded.services).toEqual([
      {
        checks: [
          { check: 'supervisor', detail: 'ActiveState=active', since: NOW - DAY, state: 'up' },
          { check: 'health', detail: 'HTTP 503', since: NOW - HOUR, state: 'unhealthy' },
        ],
        name: 'web',
        supervisor: 'systemd',
      },
    ]);
  });

  test('reads each recorded job with its schedule, its latest run, and its open job Conditions', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      records,
      runs: {
        jobs: [
          {
            job: 'backup',
            latestRun: {
              exitStatus: 2,
              finished: '2026-10-06T03:31:00Z',
              started: '2026-10-06T03:30:00Z',
            },
            latestSuccess: null,
          },
        ],
        unreadable: [],
      },
    });
    await addCondition(h.db.sql, {
      kind: 'job_failing',
      raisedAt: -3600,
      subject: 'backup',
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      clearedAt: -60,
      kind: 'job_overdue',
      raisedAt: -7200,
      subject: 'backup',
      system: 'server-1',
    });

    const { recorded } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });

    expect(recorded.jobs).toEqual([
      {
        latestRun: {
          exitStatus: 2,
          finished: Date.parse('2026-10-06T03:31:00Z'),
          started: Date.parse('2026-10-06T03:30:00Z'),
        },
        name: 'backup',
        open: ['job_failing'],
        schedule: [{ hour: 3, minute: 30 }],
      },
    ]);
  });

  test('reads each files record with how many files it holds and those that do not match', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: {
        fileRecords: [{ digest: await filesRecordDigest(DOTFILES), record: 'dotfiles' }],
        files: [
          { path: '/home/someone/.zshrc', record: 'dotfiles', since: NOW - HOUR, state: 'drifted' },
          { path: '/elsewhere', record: 'other', since: NOW - HOUR, state: 'missing' },
        ],
      },
      records,
    });

    const { recorded } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });

    expect(recorded.files).toEqual([
      {
        checked: true,
        count: 3,
        issues: [{ path: '/home/someone/.zshrc', since: NOW - HOUR, state: 'drifted' }],
        name: 'dotfiles',
      },
    ]);
  });

  test('has not checked a files record the Collector hashed in another version, or not at all', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', {
      checks: { fileRecords: [{ digest: 'f'.repeat(64), record: 'dotfiles' }], files: [] },
      records,
    });

    const stale = (await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW })).recorded;
    expect(stale.files[0]?.checked).toBe(false);

    await h.db.sql`DELETE FROM check_sets`;
    const unchecked = (await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW })).recorded;
    expect(unchecked.files[0]?.checked).toBe(false);
  });

  test('reads each application with its version, source, and who recorded it', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { records });

    const { recorded } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });

    expect(recorded.applications).toEqual([
      {
        name: 'neovim',
        provenance: { by: 'fleet', revision: 'a1b2c3d' },
        source: 'mise',
        version: '0.12.1',
      },
    ]);
  });

  test('reads nothing recorded for a System that never sent records', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');

    expect((await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW })).recorded).toEqual({
      applications: [],
      files: [],
      jobs: [],
      services: [],
    });
  });

  test('keeps recurrences distinct when their identity and raised timestamp match', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    const ended = await addCondition(h.db.sql, {
      clearedAt: -600,
      kind: 'low_disk',
      level: 'alert',
      raisedAt: -600,
      reason: 'Earlier occurrence',
      subject: '/',
      system: 'server-1',
    });
    const open = await addCondition(h.db.sql, {
      kind: 'low_disk',
      level: 'note',
      raisedAt: -600,
      reason: 'Later recurrence',
      subject: '/',
      system: 'server-1',
    });
    const { timeline: entries } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });
    expect(entries.map(({ id }) => id)).toEqual([open, ended]);
    expect(entries.map(({ transitions }) => transitions.map(({ kind }) => kind))).toEqual([
      ['raised'],
      ['raised', 'cleared'],
    ]);
  });

  test('keeps level changes inside their occurrence in recording order, with backfilled levels distinguished', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      backfilled: true,
      kind: 'low_disk',
      level: 'note',
      raisedAt: -600,
      reason: '70% used',
      subject: '/',
      system: 'server-1',
      transitions: [
        { at: -300, level: 'warning', reason: '80% used' },
        { at: -300, level: 'alert', reason: '90% used' },
      ],
    });
    await addCondition(h.db.sql, {
      clearedAt: -60,
      kind: 'service_down',
      raisedAt: -400,
      subject: 'web',
      system: 'server-1',
    });

    const { timeline: entries } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });
    expect(entries.map(({ kind }) => kind)).toEqual(['service_down', 'low_disk']);
    expect(entries[1]).toMatchObject({
      level: 'alert',
      raisedAt: NOW - 600_000,
      transitions: [
        { at: NOW - 600_000, backfilled: true, kind: 'raised', level: 'note', reason: '70% used' },
        {
          at: NOW - 300_000,
          backfilled: false,
          kind: 'level_changed',
          level: 'warning',
          previousLevel: 'note',
          reason: '80% used',
        },
        {
          at: NOW - 300_000,
          backfilled: false,
          kind: 'level_changed',
          level: 'alert',
          previousLevel: 'warning',
          reason: '90% used',
        },
      ],
    });
  });

  test('puts on the Timeline the Conditions of the last 7 days and those still open, newest raised first', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    await addCondition(h.db.sql, {
      kind: 'drift',
      raisedAt: -10 * 86_400,
      reason: 'drifted',
      subject: '/etc/a',
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      clearedAt: -600,
      kind: 'service_down',
      raisedAt: -900,
      reason: 'down',
      subject: 'web',
      system: 'server-1',
    });
    // Received last, though the Hub's clock had stepped back to stamp it earlier.
    await addCondition(h.db.sql, {
      clearedAt: -3 * 86_400,
      kind: 'low_disk',
      raisedAt: -3 * 86_400 - 600,
      reason: 'disk',
      subject: '/',
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      clearedAt: -8 * 86_400,
      kind: 'job_overdue',
      raisedAt: -9 * 86_400,
      subject: 'backup',
      system: 'server-1',
    });
    await addCondition(h.db.sql, { kind: 'system_stale', raisedAt: -60, system: 'laptop-1' });

    const { timeline: entries } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });

    expect(entries.map(({ kind }) => kind)).toEqual(['low_disk', 'service_down', 'drift']);
    expect(entries[2]).toMatchObject({
      clearedAt: undefined,
      kind: 'drift',
      raisedAt: NOW - 10 * DAY,
      reason: 'drifted',
      subject: '/etc/a',
    });
  });
});
