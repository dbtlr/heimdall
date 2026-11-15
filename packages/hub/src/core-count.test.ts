import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub } from './testing/hub.ts';
import { startTestServer } from './testing/postgres.ts';

beforeAll(startTestServer, 60_000);

test('stores the newest sample core count, replaces it, and preserves it on omission', async () => {
  await using h = await startHub();
  const read = async () => {
    const [row]: { cpu_cores: number | null }[] = await h.db.sql`
      SELECT cpu_cores FROM systems WHERE name = 'server-1'
    `;
    return row?.cpu_cores;
  };
  expect((await push(h.hub, report('server-1', [NOW]), { token: 'server-token' })).status).toBe(
    200,
  );
  expect(await read()).toBeNull();
  for (const [counts, expected] of [
    [[2, 8], 8],
    [[4], 4],
    [[undefined], 4],
    [[16, undefined], 4],
  ] satisfies [(number | undefined)[], number][]) {
    const body = report(
      'server-1',
      counts.map((_, i) => NOW + i * 15_000),
    );
    body.samples = body.samples.map((sample, i) => ({
      ...sample,
      cpu: { ...sample.cpu, cores: counts[i] },
    }));
    // oxlint-disable-next-line no-await-in-loop -- Reports must arrive in sequence to test retained state.
    expect((await push(h.hub, body, { token: 'server-token' })).status).toBe(200);
    // oxlint-disable-next-line no-await-in-loop -- Read the state after each Report commits.
    expect(await read()).toBe(expected);
  }
});
