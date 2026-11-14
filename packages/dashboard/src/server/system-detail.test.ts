import { beforeAll, describe, expect, test } from 'bun:test';

import {
  NOW,
  parseConditionLimits,
  push,
  report,
  startHub,
  storeConditionLimits,
  timeline,
  unpair,
} from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import { filesRecordDigest } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

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

// The level each Condition transition on a System page's Activity reached.
test("a System page's Activity holds that System's changes and no other System's", async () => {
  await using h = await startHub();
  await hear(h, 'server-1');
  await hear(h, 'laptop-1');
  await Promise.all(
    ['server-1', 'laptop-1'].map((system) =>
      addCondition(h.db.sql, { kind: 'low_disk', raisedAt: -3600, subject: '/', system }),
    ),
  );

  const page = await readSystemPage(h.db.sql, { name: 'laptop-1', now: NOW, range: '12h' });

  expect(page?.activity.events.map(({ system }) => system)).toEqual(['laptop-1']);
});

const conditionLevels = (page: Awaited<ReturnType<typeof readSystemPage>>) =>
  page?.activity.events.flatMap((event) => (event.kind === 'condition' ? [event.level] : []));

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
    expect(conditionLevels(page)).toEqual(['note']);
    expect(page?.attention[0]?.level).toBe('note');

    const fresh = await readSystemPage(h.db.sql, input);
    expect(fresh?.detail.status).toBe('needs_you');
    expect(fresh?.detail.conditions[0]?.level).toBe('alert');
    expect(conditionLevels(fresh)).toEqual(['note', 'alert']);
    expect(fresh?.attention[0]?.level).toBe('alert');
  } finally {
    if (writing) {
      await writer.unsafe('ROLLBACK');
    }
    await writer.release();
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

// One disk rollup of `system`'s `mount`, `daysAgo` before NOW, of 100 GiB.
const rollup = (h: Hub, system: string, mount: string, daysAgo: number, usedGiB: number) =>
  h.db.sql`
    INSERT INTO disk_rollups (system, bucket, mount, used_max, total_max)
    VALUES (${system}, ${new Date(NOW - daysAgo * DAY)}, ${mount}, ${usedGiB * GIB}, ${100 * GIB})
  `;

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

  test('describes the System from its newest Report: platform, uptime, version, load, disks, and installed Harnesses with their location', async () => {
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
    expect(found.collectorVersion).toBe('0.1.0');
    expect(found.latest).toMatchObject({
      disks: [
        { mount: '/System/Volumes/Data', totalBytes: 994_662_584_320, usedBytes: 412_316_860_416 },
      ],
      load: [1.2, 0.9, 0.7],
    });
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

  test('carries the 1-minute load per bucket from the rollups, as the average of its samples', async () => {
    await using h = await startHub();
    // One bucket's samples at loads 1, 2, and 6: the average is 3, the high 6.
    const loads = [1, 2, 6];
    await hear(h, 'server-1', {
      samples: loads.map((load, index) =>
        Object.assign(sample(NOW - HOUR + index * 15 * SECOND), { load: [load, 0.9, 0.7] }),
      ),
      times: [],
    });

    const found = await detail(h, 'server-1', '6h');

    expect(found.load).toHaveLength(1);
    expect(found.load[0]).toMatchObject({ t: NOW - HOUR });
    expect(found.load[0]?.value).toBeCloseTo(3, 9);
  });

  test('carries the CPU and memory limits and disk bands the Hub judges this System by: its own, else the fleet, else none', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');

    expect((await detail(h, 'server-1')).limitPercent).toBeUndefined();

    await storeConditionLimits(
      h.db.sql,
      parseConditionLimits({
        cpu: { percent: 75 },
        disk: { alert: 95, note: 75, warning: 85 },
        memory: { percent: 80 },
        systems: {
          'server-1': {
            cpu: { percent: 60 },
            disk: { alert: 90, note: 60, warning: 80 },
            memory: { percent: 70 },
          },
        },
      }),
    );

    expect((await detail(h, 'server-1')).limitPercent).toEqual({
      cpu: 60,
      disk: { alert: 90, note: 60, warning: 80 },
      memory: 70,
    });
    expect((await detail(h, 'laptop-1')).limitPercent).toEqual({
      cpu: 75,
      disk: { alert: 95, note: 75, warning: 85 },
      memory: 80,
    });
  });

  test("fits each mount's growth over the last 7 days whatever the range, from this System's readings alone", async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    await h.db.sql`DELETE FROM disk_rollups`;
    // server-1's `/` gains 2 GiB a day; the reading 9 days back is outside the
    // window, and laptop-1's `/` shrinks.
    await Promise.all([
      rollup(h, 'server-1', '/', 9, 1),
      rollup(h, 'server-1', '/', 3, 44),
      rollup(h, 'server-1', '/', 2, 46),
      rollup(h, 'server-1', '/', 1, 48),
      rollup(h, 'server-1', '/', 0, 50),
      rollup(h, 'laptop-1', '/', 3, 90),
      rollup(h, 'laptop-1', '/', 0, 30),
    ]);

    const { diskTrends } = await detail(h, 'server-1', '6h');

    expect(diskTrends).toHaveLength(1);
    expect(diskTrends[0]?.growth?.bytesPerDay).toBeCloseTo(2 * GIB, -3);
  });

  test('fits a silent System over the 7 days up to its newest disk reading, not up to now', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    await h.db.sql`DELETE FROM disk_rollups`;
    // Heard last 8 days ago, after a fortnight of gaining 2 GiB a day; a reading
    // stamped after now is no reading yet. Another System still reporting today
    // does not move this System's window.
    await Promise.all([
      ...Array.from({ length: 15 }, (_, day) => rollup(h, 'server-1', '/', 22 - day, 2 * day)),
      rollup(h, 'server-1', '/', -1, 99),
      rollup(h, 'laptop-1', '/', 0, 10),
    ]);

    const { diskTrends } = await detail(h, 'server-1');

    expect(diskTrends[0]?.growth?.bytesPerDay).toBeCloseTo(2 * GIB, -3);
  });

  test("carries this System's Service changes over the range, and no other System's, earlier ones, or Conditions", async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    await h.db.sql`DELETE FROM service_versions`;
    await h.db.sql`
      INSERT INTO service_versions (system, service, version, upstream, first_seen_at) VALUES
        ('server-1', 'web', '1.8.1', null, ${new Date(NOW - 30 * HOUR)}),
        ('server-1', 'web', '1.8.2', null, ${new Date(NOW - 12 * HOUR)}),
        ('server-1', 'web', '1.8.3', null, ${new Date(NOW - 2 * HOUR)}),
        ('laptop-1', 'web', '1.8.1', null, ${new Date(NOW - 30 * HOUR)}),
        ('laptop-1', 'web', '1.8.2', null, ${new Date(NOW - 2 * HOUR)})
    `;
    await h.db.sql`
      INSERT INTO service_stops (system, service, stopped_at, ongoing, restarts, sent_at, received_at) VALUES
        ('server-1', 'web', ${new Date(NOW - 2 * HOUR + MINUTE)}, false, 0, ${new Date(NOW)}, ${new Date(NOW)}),
        ('server-1', 'web', ${new Date(NOW - 10 * HOUR)}, false, 0, ${new Date(NOW)}, ${new Date(NOW)}),
        ('laptop-1', 'web', ${new Date(NOW - 2 * HOUR)}, false, 0, ${new Date(NOW)}, ${new Date(NOW)})
    `;
    // Conditions show on the lane as spans, not as changes.
    await addCondition(h.db.sql, {
      kind: 'drift',
      raisedAt: -3600,
      subject: '/etc/hosts',
      system: 'server-1',
    });

    const oldestFirst = async (range: '6h' | '24h') =>
      (await detail(h, 'server-1', range)).changes.toSorted((a, b) => a.at - b.at);
    const recent = await oldestFirst('6h');
    const day = await oldestFirst('24h');

    expect(recent.map(({ at, kind }) => [kind, NOW - at])).toEqual([
      ['version', 2 * HOUR],
      ['stop', 2 * HOUR - MINUTE],
    ]);
    expect(day.map(({ at, kind }) => [kind, NOW - at])).toEqual([
      ['version', 12 * HOUR],
      ['stop', 10 * HOUR],
      ['version', 2 * HOUR],
      ['stop', 2 * HOUR - MINUTE],
    ]);
    expect(day.every(({ system }) => system === 'server-1')).toBe(true);
  });

  test("keeps an unpaired System's Service changes on its own page", async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1');
    await h.db.sql`DELETE FROM service_versions`;
    await h.db.sql`
      INSERT INTO service_versions (system, service, version, upstream, first_seen_at) VALUES
        ('laptop-1', 'web', '1.8.1', null, ${new Date(NOW - 30 * HOUR)}),
        ('laptop-1', 'web', '1.8.2', null, ${new Date(NOW - 2 * HOUR)})
    `;
    await h.db.sql`
      INSERT INTO service_stops (system, service, stopped_at, ongoing, restarts, sent_at, received_at) VALUES
        ('laptop-1', 'cache', ${new Date(NOW - HOUR)}, false, 0, ${new Date(NOW)}, ${new Date(NOW)})
    `;
    await unpair(h.db.sql, 'laptop-1');

    const found = await detail(h, 'laptop-1', '6h');

    expect(found.paired).toBe(false);
    expect(found.changes.map(({ kind }) => kind).toSorted()).toEqual(['stop', 'version']);
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

  test('keeps its Activity, labelled unpaired', async () => {
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

    const page = await readSystemPage(h.db.sql, { name: 'laptop-1', now: NOW, range: '12h' });

    expect(
      page?.activity.events.map((event) =>
        event.kind === 'condition' ? [event.condition, event.action, event.reason] : [],
      ),
    ).toEqual([
      ['system_stale', 'raised', 'Not heard from.'],
      ['system_stale', 'cleared', 'Not heard from.'],
    ]);
    expect(page?.activity.unpaired).toEqual(['laptop-1']);
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
        update: undefined,
        version: null,
      },
    ]);
  });

  test("reads a recorded Service's installed version and its available update, from the Services page's reader", async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { records });
    await hear(h, 'laptop-1', { records });
    await h.db.sql`DELETE FROM service_versions`;
    await h.db.sql`
      INSERT INTO service_versions (system, service, version, upstream, first_seen_at) VALUES
        ('server-1', 'web', '1.0', 'github:owner/web', ${new Date(NOW)}),
        ('laptop-1', 'web', '1.0', 'github:owner/other', ${new Date(NOW)})
    `;
    await h.db.sql`
      INSERT INTO upstream_checks (upstream, releases, checked_at, succeeded_at, failure, next_check_at) VALUES
        ('github:owner/web', '{"":"2.0"}', ${new Date(NOW)}, ${new Date(NOW)}, null, ${new Date(NOW)}),
        ('github:owner/other', '{"":"1.0"}', ${new Date(NOW)}, ${new Date(NOW)}, null, ${new Date(NOW)})
    `;

    const server = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });
    const laptop = await readSystemRecords(h.db.sql, { name: 'laptop-1', now: NOW });

    expect(server.recorded.services.map(({ update, version }) => ({ update, version }))).toEqual([
      { update: '2.0', version: '1.0' },
    ]);
    expect(laptop.recorded.services.map(({ update, version }) => ({ update, version }))).toEqual([
      { update: undefined, version: '1.0' },
    ]);
  });

  test("keeps an unpaired System's recorded Services' installed versions on its own page", async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1', { records });
    await h.db.sql`DELETE FROM service_versions`;
    await h.db.sql`
      INSERT INTO service_versions (system, service, version, upstream, first_seen_at) VALUES
        ('laptop-1', 'web', '1.0', 'github:owner/web', ${new Date(NOW)})
    `;
    await unpair(h.db.sql, 'laptop-1');

    const laptop = await readSystemRecords(h.db.sql, { name: 'laptop-1', now: NOW });

    expect(laptop.recorded.services.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: 'web', version: '1.0' },
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

    await h.db.sql`UPDATE systems SET time_zone = 'UTC' WHERE name = 'server-1'`;

    const { recorded } = await readSystemRecords(h.db.sql, { name: 'server-1', now: NOW });

    expect(recorded.jobs).toEqual([
      {
        latestRun: {
          exitStatus: 2,
          finished: Date.parse('2026-10-06T03:31:00Z'),
          started: Date.parse('2026-10-06T03:30:00Z'),
        },
        name: 'backup',
        nextRunAt: Date.UTC(2026, 9, 7, 3, 30),
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
});

type Holder = { name: string; pid: number; rssBytes: number };

// A sample `seconds` after NOW, carrying `topByMemory` when given, as a
// Collector `uptimeSeconds` after its boot takes it.
const memorySample = (seconds: number, topByMemory?: Holder[], uptimeSeconds = 86_400) => ({
  ...sample(NOW + seconds * SECOND),
  uptimeSeconds,
  ...(topByMemory && {
    processes: {
      bootId: 'boot-1',
      census: { kind: 'partial' as const },
      intervalMs: 15_000,
      top: [],
      topByMemory: topByMemory.map((holder) => ({ ...holder, start: '1' })),
    },
  }),
});

const hearSamples = async (h: Hub, samples: ReturnType<typeof memorySample>[]) => {
  h.clock.now = NOW;
  const response = await push(
    h.hub,
    { ...report('server-1', []), samples },
    { token: 'server-token' },
  );
  expect(response.status).toBe(200);
};

describe('the processes holding the most memory', () => {
  const older = [{ name: 'postgres', pid: 7, rssBytes: 3 * GIB }];
  const newer = [
    { name: 'postgres', pid: 7, rssBytes: 4 * GIB },
    { name: 'bun', pid: 42, rssBytes: GIB },
  ];

  test('come from the newest sample at or before the inspected one that carries them, up to two minutes older', async () => {
    await using h = await startHub();
    await hearSamples(h, [
      memorySample(-420, older),
      ...[-405, -390, -255].map((seconds) => memorySample(seconds)),
      memorySample(-240, older),
      ...[-225, -135].map((seconds) => memorySample(seconds)),
      memorySample(-120, newer),
      memorySample(-105),
      memorySample(0),
    ]);

    expect((await inspect(h, NOW - 105_000)).memoryHolders).toEqual({
      processes: newer,
      t: NOW - 120_000,
    });
    expect((await inspect(h, NOW - 120_000)).memoryHolders?.t).toBe(NOW - 120_000);
    expect((await inspect(h, NOW)).memoryHolders?.t).toBe(NOW - 120_000);
    expect((await inspect(h, NOW - 135_000)).memoryHolders).toEqual({
      processes: older,
      t: NOW - 240_000,
    });
    expect((await inspect(h, NOW - 255_000)).memoryHolders).toBeUndefined();
  });

  test('are none from before a reboot, from an empty list, or where no sample carries them', async () => {
    await using h = await startHub();
    await hearSamples(h, [
      memorySample(-600, newer),
      memorySample(-585),
      memorySample(-300, newer),
      memorySample(-285, undefined, 10),
      memorySample(-60, []),
      memorySample(-45),
    ]);

    expect((await inspect(h, NOW - 585_000)).memoryHolders?.t).toBe(NOW - 600_000);
    expect((await inspect(h, NOW - 285_000)).memoryHolders).toBeUndefined();
    expect((await inspect(h, NOW - 45_000)).memoryHolders).toBeUndefined();
  });
});
