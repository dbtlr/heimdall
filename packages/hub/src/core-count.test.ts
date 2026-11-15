import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub } from './testing/hub.ts';
import { startTestServer } from './testing/postgres.ts';

beforeAll(startTestServer, 60_000);

test('an out-of-range count leaves the Report stored and the known count unchanged', async () => {
  await using h = await startHub();
  const initial = report('server-1', [NOW]);
  initial.samples[0]!.cpu.cores = 8;
  expect((await push(h.hub, initial, { token: 'server-token' })).status).toBe(200);
  const body = report('server-1', [NOW + 15_000]);
  body.samples[0]!.cpu = { busyPercent: 37, cores: 2 ** 31 };
  const response = await push(h.hub, body, { token: 'server-token' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ skipped: 0, stored: 1 });
  const [system]: { cpu_cores: number }[] = await h.db
    .sql`SELECT cpu_cores FROM systems WHERE name = 'server-1'`;
  expect(system?.cpu_cores).toBe(8);
  const [vitals]: { cpu_busy_percent: number; load_1: number; memory_used_bytes: number }[] =
    await h.db.sql`
    SELECT cpu_busy_percent, load_1, memory_used_bytes::float8 AS memory_used_bytes FROM vitals_samples
    WHERE system = 'server-1' AND t = ${new Date(NOW + 15_000)}
  `;
  expect(vitals).toEqual({
    cpu_busy_percent: 37,
    load_1: body.samples[0]!.load[0],
    memory_used_bytes: body.samples[0]!.memory.usedBytes,
  });
});

test('only a strictly newer sample can replace the core count', async () => {
  await using h = await startHub();
  for (const [offset, cores, expected] of [
    [200, 8, 8],
    [100, 4, 8],
    [200, 2, 8],
    [300, 16, 16],
    [400, undefined, 16],
    [350, 32, 32],
  ] satisfies [number, number | undefined, number][]) {
    const body = report('server-1', [NOW + offset * 1000]);
    body.samples = body.samples.map((sample) => ({ ...sample, cpu: { ...sample.cpu, cores } }));
    // oxlint-disable-next-line no-await-in-loop -- Arrival order is the behavior under test.
    expect((await push(h.hub, body, { token: 'server-token' })).status).toBe(200);
    // oxlint-disable-next-line no-await-in-loop -- Check the state after each Report commits.
    const [row]: { cpu_cores: number }[] = await h.db
      .sql`SELECT cpu_cores FROM systems WHERE name = 'server-1'`;
    expect(row?.cpu_cores).toBe(expected);
  }
});

test('uses only the newest sample in a Report for the core count', async () => {
  await using h = await startHub();
  const first = report('server-1', [NOW, NOW + 15_000]);
  first.samples = first.samples.map((sample, i) => ({
    ...sample,
    cpu: { ...sample.cpu, cores: i === 0 ? 2 : 8 },
  }));
  expect((await push(h.hub, first, { token: 'server-token' })).status).toBe(200);
  const newer = report('server-1', [NOW + 30_000, NOW + 45_000]);
  newer.samples = newer.samples.map((sample, i) => ({
    ...sample,
    cpu: { ...sample.cpu, cores: i === 0 ? 16 : undefined },
  }));
  expect((await push(h.hub, newer, { token: 'server-token' })).status).toBe(200);
  const [row]: { cpu_cores: number; cpu_cores_at: Date }[] = await h.db.sql`
    SELECT cpu_cores, cpu_cores_at FROM systems WHERE name = 'server-1'
  `;
  expect(row).toEqual({ cpu_cores: 8, cpu_cores_at: new Date(NOW + 15_000) });
});
