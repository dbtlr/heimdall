import { expect, test } from 'bun:test';

import type { HarnessProcess } from '@heimdall/schema';

import { listHarnessProcesses } from './harness-processes.ts';
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

test('stores a running Harness process with what the Collector read', async () => {
  await using h = await startHub();
  await pushProcesses(h, 'laptop-1', [running()]);

  expect(await rowsOf(h, 'laptop-1')).toEqual([
    {
      cpuMicros: 5_000_000,
      cwd: '/work/project',
      endMissed: false,
      endedAt: undefined,
      harness: 'claude-code',
      lastSeenAt: NOW,
      peakRssBytes: 600,
      pid: 4242,
      rssBytes: 500,
      startedAt: START,
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
  expect(rows[0]).toMatchObject({ cpuMicros: 9_000_000, peakRssBytes: 600, rssBytes: 300 });
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
  await pushProcesses(h, 'laptop-1', [running({ cpuMicros: 9_000_000 })], {
    sentAt: NOW + 15_000,
    t: NOW + 15_000,
  });
  await pushProcesses(h, 'laptop-1', [running({ cpuMicros: 1_000_000, pid: 7 })], {
    sentAt: NOW,
    t: NOW,
  });

  const rows = await rowsOf(h, 'laptop-1');

  expect(rows.find((r) => r.pid === 4242)).toMatchObject({ cpuMicros: 9_000_000 });
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
