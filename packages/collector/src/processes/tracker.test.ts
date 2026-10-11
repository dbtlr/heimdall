import { expect, test } from 'bun:test';

import { HarnessProcessesSectionSchema, MAX_HARNESS_PROCESSES } from '@heimdall/schema';

import type { ProcessEntry, ProcessReader } from './table.ts';
import { createProcessTracker } from './tracker.ts';

const BASE = 1_759_000_000_000;

const entry = (pid: number, over: Partial<ProcessEntry> = {}): ProcessEntry => ({
  cpuMicros: 0,
  kernelStart: null,
  name: 'claude',
  pid,
  ppid: 1,
  rssBytes: 0,
  startedAt: BASE + pid * 1000,
  ...over,
});

// A process table a test changes between ticks, with working directories.
const host = () => {
  const state: { cwds: Record<number, string | null>; table: ProcessEntry[]; failing?: boolean } = {
    cwds: {},
    table: [],
  };
  const reader: ProcessReader = {
    cwdOf: (pid) => Promise.resolve(state.cwds[pid] ?? null),
    table: () =>
      state.failing ? Promise.reject(new Error('ps failed')) : Promise.resolve(state.table),
  };
  let now = BASE + 100_000;
  const tracker = createProcessTracker({ now: () => now, reader });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    state,
    tracker,
  };
};

test('has no section until the first tick', () => {
  expect(host().tracker.latest()).toBeUndefined();
});

test('a System with no Harness process has a section that lists nothing', async () => {
  const h = host();
  h.state.table = [entry(5, { name: 'sshd' })];

  await h.tracker.tick();

  expect(h.tracker.latest()).toEqual({ processes: [] });
});

test('a running Harness root is reported with its start, working directory, totals, and last sighting', async () => {
  const h = host();
  h.state.table = [
    entry(10, { cpuMicros: 4000, rssBytes: 100 }),
    entry(11, { cpuMicros: 1000, name: 'bun', ppid: 10, rssBytes: 50 }),
  ];
  h.state.cwds[10] = '/work/project';

  await h.tracker.tick();

  expect(h.tracker.latest()).toEqual({
    processes: [
      {
        cpuMicros: 5000,
        cwd: '/work/project',
        harness: 'claude-code',
        lastSeenAt: h.now(),
        peakRssBytes: 150,
        pid: 10,
        rssBytes: 150,
        startedAt: BASE + 10_000,
      },
    ],
  });
});

test('later ticks update the totals and keep the highest memory seen', async () => {
  const h = host();
  h.state.table = [entry(10, { cpuMicros: 100, rssBytes: 900 })];
  await h.tracker.tick();
  h.advance(15_000);
  h.state.table = [entry(10, { cpuMicros: 300, rssBytes: 400 })];

  await h.tracker.tick();

  expect(h.tracker.latest()?.processes[0]).toMatchObject({
    cpuMicros: 300,
    lastSeenAt: h.now(),
    peakRssBytes: 900,
    rssBytes: 400,
  });
});

test('a process seen on one tick and gone on the next gets the end of the tick that missed it', async () => {
  const h = host();
  h.state.table = [entry(10), entry(11)];
  await h.tracker.tick();
  const seenAt = h.now();
  h.advance(15_000);
  h.state.table = [entry(11)];

  await h.tracker.tick();

  const [ended, running] = h.tracker.latest()?.processes ?? [];
  expect(ended).toMatchObject({ endedAt: h.now(), lastSeenAt: seenAt, pid: 10 });
  expect(running?.pid).toBe(11);
  expect(running).not.toHaveProperty('endedAt');
});

test('an ended process rides every section until the Hub acknowledges it', async () => {
  const h = host();
  h.state.table = [entry(10)];
  await h.tracker.tick();
  h.advance(15_000);
  h.state.table = [];
  await h.tracker.tick();
  const delivered = h.tracker.latest();
  h.advance(15_000);
  await h.tracker.tick();
  const stillCarried = h.tracker.latest();

  h.tracker.settled(delivered ?? { processes: [] });
  await h.tracker.tick();

  expect(delivered?.processes.map((p) => p.pid)).toEqual([10]);
  expect(stillCarried?.processes.map((p) => p.pid)).toEqual([10]);
  expect(h.tracker.latest()).toEqual({ processes: [] });
});

test('a process that ended after the acknowledged section was built is still carried', async () => {
  const h = host();
  h.state.table = [entry(10), entry(11)];
  await h.tracker.tick();
  h.advance(15_000);
  h.state.table = [entry(11)];
  await h.tracker.tick();
  const delivered = h.tracker.latest();
  h.advance(15_000);
  h.state.table = [];
  await h.tracker.tick();

  h.tracker.settled(delivered ?? { processes: [] });
  await h.tracker.tick();

  expect(h.tracker.latest()?.processes.map((p) => [p.pid, p.endedAt !== undefined])).toEqual([
    [11, true],
  ]);
});

test('a pid reused by a new process ends the old one and starts another', async () => {
  const h = host();
  h.state.table = [entry(10, { startedAt: BASE })];
  await h.tracker.tick();
  h.advance(15_000);
  h.state.table = [entry(10, { startedAt: BASE + 50_000 })];

  await h.tracker.tick();

  expect(
    h.tracker.latest()?.processes.map((p) => [p.pid, p.startedAt, p.endedAt !== undefined]),
  ).toEqual([
    [10, BASE, true],
    [10, BASE + 50_000, false],
  ]);
});

test('a start time that moves by a second is the same process', async () => {
  const h = host();
  h.state.table = [entry(10, { startedAt: BASE })];
  await h.tracker.tick();
  h.state.table = [entry(10, { startedAt: BASE + 1000 })];

  await h.tracker.tick();

  expect(h.tracker.latest()?.processes).toHaveLength(1);
  expect(h.tracker.latest()?.processes[0]?.startedAt).toBe(BASE);
});

test('a working directory that cannot be read is null, and a known one is kept', async () => {
  const h = host();
  h.state.table = [entry(10)];
  await h.tracker.tick();
  const unknown = h.tracker.latest()?.processes[0]?.cwd;
  h.state.cwds[10] = '/work/a';
  await h.tracker.tick();
  h.state.cwds[10] = null;

  await h.tracker.tick();

  expect(unknown).toBeNull();
  expect(h.tracker.latest()?.processes[0]?.cwd).toBe('/work/a');
});

test('a failed read of the process table changes nothing, so no process is ended by it', async () => {
  const h = host();
  h.state.table = [entry(10)];
  await h.tracker.tick();
  const before = h.tracker.latest();
  h.state.failing = true;

  const failure = await h.tracker.tick().catch((error: unknown) => error);

  expect(failure).toEqual(new Error('ps failed'));

  expect(h.tracker.latest()).toBe(before);
});

test('keeps the newest ended processes when the Hub is gone so long that they pass the budget', async () => {
  const h = host();
  const total = MAX_HARNESS_PROCESSES + 5;
  for (let pid = 1; pid <= total; pid += 1) {
    h.state.table = [entry(pid)];
    // oxlint-disable-next-line no-await-in-loop -- one tick after another.
    await h.tracker.tick();
    h.advance(1000);
  }
  h.state.table = [];
  await h.tracker.tick();

  const pids = h.tracker.latest()?.processes.map((p) => p.pid) ?? [];

  expect(pids).toHaveLength(MAX_HARNESS_PROCESSES);
  expect(pids.at(-1)).toBe(total);
});

test('running and ended processes together stay within the budget, the oldest ended dropped first', async () => {
  const h = host();
  for (let pid = 1; pid <= MAX_HARNESS_PROCESSES; pid += 1) {
    h.state.table = [entry(pid)];
    // oxlint-disable-next-line no-await-in-loop -- one tick after another.
    await h.tracker.tick();
    h.advance(1000);
  }
  h.state.table = [entry(9000), entry(9001)];
  await h.tracker.tick();

  const section = h.tracker.latest();
  const processes = section?.processes ?? [];

  expect(HarnessProcessesSectionSchema.safeParse(section).success).toBe(true);
  expect(processes).toHaveLength(MAX_HARNESS_PROCESSES);
  expect(processes.filter((p) => p.endedAt === undefined).map((p) => p.pid)).toEqual([9000, 9001]);
  // The 512 ended processes lose the two oldest to the two running.
  expect(processes[0]?.pid).toBe(3);
  expect(processes.at(-3)?.pid).toBe(MAX_HARNESS_PROCESSES);
});
