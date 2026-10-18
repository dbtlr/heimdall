import { expect, test } from 'bun:test';

import type { HarnessProcess } from '@heimdall/schema';

import { listHarnessProcesses, listHarnessProcessSamples } from './harness-processes.ts';
import { pruneVitals } from './retention.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

const START = NOW - 3_600_000;

const running = (over: Partial<HarnessProcess> = {}): HarnessProcess => ({
  cpuMicros: 5_000_000,
  cwd: '/work/project',
  harness: 'claude-code',
  lastSeenAt: NOW,
  peakRssBytes: 600,
  pid: 4242,
  repository: '/work/project',
  rssBytes: 500,
  startedAt: START,
  ...over,
});

const TOKENS = { 'laptop-1': 'laptop-token', 'server-1': 'server-token' } as const;

// Pushes a Report from `system` sent at `sentAt` carrying `processes`.
const pushProcesses = async (
  h: Hub,
  system: keyof typeof TOKENS,
  processes: HarnessProcess[] | undefined,
  { sentAt = NOW, t = sentAt }: { sentAt?: number; t?: number } = {},
) => {
  const response = await push(
    h.hub,
    {
      ...report(system, [t]),
      sentAt,
      ...(processes === undefined ? {} : { harnessProcesses: { processes } }),
    },
    { token: TOKENS[system] },
  );
  expect(response.status).toBe(200);
};

const rowsOf = (h: Hub, system: string) => listHarnessProcesses(h.db.sql, system);
const samplesOf = (h: Hub, system: string) => listHarnessProcessSamples(h.db.sql, system);

const DAY = 86_400_000;

test('stores a running Harness process with what the Collector read', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);

  expect(await rowsOf(h, 'laptop-1')).toEqual([
    {
      cwd: '/work/project',
      endMissed: false,
      endedAt: undefined,
      harness: 'claude-code',
      lastSeenAt: NOW,
      peakRssBytes: 600,
      pid: 4242,
      repository: '/work/project',
      startedAt: START,
    },
  ]);
  expect(await samplesOf(h, 'laptop-1')).toEqual([
    {
      cpuMicros: 5_000_000,
      harness: 'claude-code',
      pid: 4242,
      rssBytes: 500,
      startedAt: START,
      t: NOW,
    },
  ]);
});

test('a later Report updates the process in place, and the peak memory only grows', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(
    h,
    'laptop-1',
    [running({ cpuMicros: 9_000_000, lastSeenAt: NOW + 15_000, peakRssBytes: 400, rssBytes: 300 })],
    { sentAt: NOW + 15_000, t: NOW + 15_000 },
  );

  const rows = await rowsOf(h, 'laptop-1');

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ lastSeenAt: NOW + 15_000, peakRssBytes: 600 });
  expect((await samplesOf(h, 'laptop-1')).map((r) => [r.t, r.cpuMicros, r.rssBytes])).toEqual([
    [NOW, 5_000_000, 500],
    [NOW + 15_000, 9_000_000, 300],
  ]);
});

test('a start time a second apart is the same process, and a pid reused much later is another', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(h, 'laptop-1', [running({ startedAt: START + 1000 })], {
    sentAt: NOW + 15_000,
    t: NOW + 15_000,
  });
  await pushProcesses(h, 'laptop-1', [running({ startedAt: START + 600_000 })], {
    sentAt: NOW + 30_000,
    t: NOW + 30_000,
  });

  expect((await rowsOf(h, 'laptop-1')).map((r) => r.startedAt)).toEqual([START, START + 600_000]);
});

test('an end the Collector saw is stored as the end', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(h, 'laptop-1', [running({ endedAt: NOW + 15_000 })], {
    sentAt: NOW + 15_000,
    t: NOW + 15_000,
  });

  expect((await rowsOf(h, 'laptop-1'))[0]).toMatchObject({
    endMissed: false,
    endedAt: NOW + 15_000,
  });
});

test('a running process a later section no longer lists ended while the Collector was not looking', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running(), running({ pid: 5000 })]);
  await pushProcesses(h, 'laptop-1', [running({ lastSeenAt: NOW + 3_600_000, pid: 5000 })], {
    sentAt: NOW + 3_600_000,
    t: NOW + 3_600_000,
  });

  const rows = await rowsOf(h, 'laptop-1');

  expect(rows.find((r) => r.pid === 4242)).toMatchObject({
    endMissed: true,
    // The last time the Collector saw it, since the end itself is not known.
    endedAt: NOW,
  });
  expect(rows.find((r) => r.pid === 5000)?.endedAt).toBeUndefined();
});

test('an empty section ends every process the System was running', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(h, 'laptop-1', [], { sentAt: NOW + 15_000, t: NOW + 15_000 });

  expect((await rowsOf(h, 'laptop-1'))[0]).toMatchObject({ endMissed: true, endedAt: NOW });
});

test('a Report without the section changes nothing', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(h, 'laptop-1', undefined, { sentAt: NOW + 15_000, t: NOW + 15_000 });

  expect((await rowsOf(h, 'laptop-1'))[0]?.endedAt).toBeUndefined();
});

test("one System's section never touches another System's processes", async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(h, 'server-1', [], { sentAt: NOW + 15_000, t: NOW + 15_000 });

  expect((await rowsOf(h, 'laptop-1'))[0]?.endedAt).toBeUndefined();
  expect(await rowsOf(h, 'server-1')).toEqual([]);
});

test('a section sent earlier does not undo one sent later', async () => {
  await using h = await startHub();
  // Both arrive after they were sent, so neither claims a time after the Hub's.
  h.clock.now = NOW + 60_000;
  await pushProcesses(h, 'laptop-1', [running()], {
    sentAt: NOW + 15_000,
    t: NOW + 15_000,
  });
  await pushProcesses(h, 'laptop-1', [running({ lastSeenAt: NOW - 15_000, pid: 7 })], {
    sentAt: NOW,
    t: NOW,
  });

  const rows = await rowsOf(h, 'laptop-1');

  expect(rows.find((r) => r.pid === 4242)).toMatchObject({ lastSeenAt: NOW });
  expect(rows.find((r) => r.pid === 7)?.endedAt).toBeUndefined();
  expect(rows.find((r) => r.pid === 4242)?.endedAt).toBeUndefined();
});

test('a process whose working directory the Collector could not read is stored with none, and a later one fills it in', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running({ cwd: null })]);
  const unknown = (await rowsOf(h, 'laptop-1'))[0]?.cwd;
  await pushProcesses(h, 'laptop-1', [running({ lastSeenAt: NOW + 15_000 })], {
    sentAt: NOW + 15_000,
    t: NOW + 15_000,
  });

  expect(unknown).toBeNull();
  expect((await rowsOf(h, 'laptop-1'))[0]?.cwd).toBe('/work/project');
});

test('a process whose repository the Collector could not resolve is stored with none, and a later one fills it in', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running({ repository: null })]);
  const unknown = (await rowsOf(h, 'laptop-1'))[0]?.repository;
  await pushProcesses(h, 'laptop-1', [running({ lastSeenAt: NOW + 15_000 })], {
    sentAt: NOW + 15_000,
    t: NOW + 15_000,
  });
  const filled = (await rowsOf(h, 'laptop-1'))[0]?.repository;
  const { repository: _, ...older } = running({ lastSeenAt: NOW + 30_000 });
  await pushProcesses(h, 'laptop-1', [older], { sentAt: NOW + 30_000, t: NOW + 30_000 });

  expect(unknown).toBeNull();
  expect(filled).toBe('/work/project');
  expect((await rowsOf(h, 'laptop-1'))[0]?.repository).toBe('/work/project');
});

test('a process that moves to a directory outside any repository loses the repository it had', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(
    h,
    'laptop-1',
    [running({ cwd: '/tmp/scratch', lastSeenAt: NOW + 15_000, repository: null })],
    { sentAt: NOW + 15_000, t: NOW + 15_000 },
  );

  expect((await rowsOf(h, 'laptop-1'))[0]).toMatchObject({ cwd: '/tmp/scratch', repository: null });
});

test('a section that could not read the working directory keeps the directory and its repository', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(
    h,
    'laptop-1',
    [running({ cwd: null, lastSeenAt: NOW + 15_000, repository: null })],
    { sentAt: NOW + 15_000, t: NOW + 15_000 },
  );

  expect((await rowsOf(h, 'laptop-1'))[0]).toMatchObject({
    cwd: '/work/project',
    repository: '/work/project',
  });
});

test('a pid reused within seconds of an ended process is stored as another process beside the one held', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(
    h,
    'laptop-1',
    [
      running({ endedAt: NOW + 15_000 }),
      running({ lastSeenAt: NOW + 15_000, startedAt: START + 7000 }),
    ],
    { sentAt: NOW + 15_000, t: NOW + 15_000 },
  );

  expect((await rowsOf(h, 'laptop-1')).map((r) => [r.startedAt, r.endedAt])).toEqual([
    [START, NOW + 15_000],
    [START + 7000, undefined],
  ]);
});

test('a pid reused within the start window is still told apart: each process takes the row closest to its start', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(
    h,
    'laptop-1',
    [
      running({ endedAt: NOW + 15_000 }),
      running({ lastSeenAt: NOW + 15_000, startedAt: START + 3000 }),
    ],
    { sentAt: NOW + 15_000, t: NOW + 15_000 },
  );

  expect((await rowsOf(h, 'laptop-1')).map((r) => [r.startedAt, r.endedAt])).toEqual([
    [START, NOW + 15_000],
    [START + 3000, undefined],
  ]);
});

test('an ended process stays ended when a later section lists only the process that reused its pid', async () => {
  for (const apart of [3000, 7000]) {
    // oxlint-disable-next-line no-await-in-loop -- one Hub per case.
    await using h = await startHub();
    // oxlint-disable-next-line no-await-in-loop -- in order.
    await pushProcesses(h, 'laptop-1', [
      running({ endedAt: NOW }),
      running({ startedAt: START + apart }),
    ]);
    // oxlint-disable-next-line no-await-in-loop -- in order.
    await pushProcesses(
      h,
      'laptop-1',
      [running({ lastSeenAt: NOW + 15_000, startedAt: START + apart })],
      {
        sentAt: NOW + 15_000,
        t: NOW + 15_000,
      },
    );

    // oxlint-disable-next-line no-await-in-loop -- in order.
    const rows = await rowsOf(h, 'laptop-1');

    expect(rows.map((r) => [r.startedAt, r.endedAt, r.endMissed])).toEqual([
      [START, NOW, false],
      [START + apart, undefined, false],
    ]);
  }
});

test('a start read a second apart keeps the running process open, as one row', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(
    h,
    'laptop-1',
    [running({ lastSeenAt: NOW + 15_000, startedAt: START + 1000 })],
    {
      sentAt: NOW + 15_000,
      t: NOW + 15_000,
    },
  );

  expect(await rowsOf(h, 'laptop-1')).toEqual([
    expect.objectContaining({ endMissed: false, endedAt: undefined, lastSeenAt: NOW + 15_000 }),
  ]);
});

test('an end the Collector reports after the Hub closed the process as missed replaces the missed one', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);
  await pushProcesses(h, 'laptop-1', [], { sentAt: NOW + 15_000, t: NOW + 15_000 });
  await pushProcesses(h, 'laptop-1', [running({ endedAt: NOW + 10_000 })], {
    sentAt: NOW + 30_000,
    t: NOW + 30_000,
  });

  expect((await rowsOf(h, 'laptop-1'))[0]).toMatchObject({
    endMissed: false,
    endedAt: NOW + 10_000,
  });
});

// A Report from a Collector whose clock ran a day ahead of the Hub's.
const AHEAD = NOW + DAY;

test('a process stored from a Report with a clock ahead of the Hub is updated by a later Report with a good clock', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()], { sentAt: AHEAD, t: NOW });
  await pushProcesses(h, 'laptop-1', [running({ endedAt: NOW + 15_000 })], {
    sentAt: NOW + 15_000,
    t: NOW + 15_000,
  });

  expect((await rowsOf(h, 'laptop-1'))[0]).toMatchObject({
    endMissed: false,
    endedAt: NOW + 15_000,
  });
});

test('a process stored from a Report with a clock ahead of the Hub is closed by a later Report with a good clock that no longer lists it', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()], { sentAt: AHEAD, t: NOW });
  await pushProcesses(h, 'laptop-1', [], { sentAt: NOW + 15_000, t: NOW + 15_000 });

  expect((await rowsOf(h, 'laptop-1'))[0]).toMatchObject({ endMissed: true, endedAt: NOW });
});

test('a section resent with the same reading stores it once', async () => {
  await using h = await startHub();
  const ended = running({ endedAt: NOW + 15_000 });
  await pushProcesses(h, 'laptop-1', [ended]);
  await pushProcesses(h, 'laptop-1', [ended], { sentAt: NOW + 15_000, t: NOW + 15_000 });

  expect(await samplesOf(h, 'laptop-1')).toHaveLength(1);
});

// The 5-minute rollups of a System's process samples, by process start and bucket.
const rollupsOf = async (h: Hub) => {
  const rows: {
    bucket: Date;
    cpu_micros_max: string;
    cpu_micros_min: string;
    rss_max: string;
    rss_min: string;
    rss_sum: string;
    samples: number;
  }[] = await h.db.sql`
    SELECT r.bucket, r.samples, r.cpu_micros_min, r.cpu_micros_max, r.rss_min, r.rss_sum, r.rss_max
    FROM harness_process_rollups r ORDER BY r.bucket
  `;
  return rows.map((r) => ({
    bucket: r.bucket.getTime(),
    cpu: [Number(r.cpu_micros_min), Number(r.cpu_micros_max)],
    rss: [Number(r.rss_min), Number(r.rss_sum), Number(r.rss_max)],
    samples: r.samples,
  }));
};

test("each reading rolls up into its process's 5-minute bucket, once, as Vitals do", async () => {
  await using h = await startHub();
  // NOW is on a 5-minute boundary.
  const readings = [
    running({ cpuMicros: 1_000_000, lastSeenAt: NOW, rssBytes: 100 }),
    running({ cpuMicros: 3_000_000, lastSeenAt: NOW + 15_000, rssBytes: 300 }),
    running({ cpuMicros: 4_000_000, lastSeenAt: NOW + 300_000, rssBytes: 200 }),
  ];
  for (const reading of readings) {
    // oxlint-disable-next-line no-await-in-loop -- in order.
    await pushProcesses(h, 'laptop-1', [reading], {
      sentAt: reading.lastSeenAt,
      t: reading.lastSeenAt,
    });
  }
  // Resent: rolls up no second time.
  await pushProcesses(h, 'laptop-1', [readings[1] ?? running()], {
    sentAt: NOW + 301_000,
    t: NOW + 301_000,
  });

  expect(await rollupsOf(h)).toEqual([
    { bucket: NOW, cpu: [1_000_000, 3_000_000], rss: [100, 400, 300], samples: 2 },
    { bucket: NOW + 300_000, cpu: [4_000_000, 4_000_000], rss: [200, 200, 200], samples: 1 },
  ]);
});

test('pruning removes process samples after 14 days and their rollups after a year, and keeps the processes', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running({ lastSeenAt: NOW - 20 * DAY })], {
    t: NOW - 20 * DAY,
  });
  await pushProcesses(h, 'laptop-1', [running({ lastSeenAt: NOW - 400 * DAY, pid: 7 })], {
    t: NOW - 400 * DAY,
  });

  const pruned = await pruneVitals(h.db.sql, NOW);

  expect(pruned).toMatchObject({ processRollups: 1, processSamples: 2 });
  expect(await samplesOf(h, 'laptop-1')).toEqual([]);
  expect((await rollupsOf(h)).map((r) => r.bucket)).toEqual([NOW - 20 * DAY]);
  expect(await rowsOf(h, 'laptop-1')).toHaveLength(2);
});
