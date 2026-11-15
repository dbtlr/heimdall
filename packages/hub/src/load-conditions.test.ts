import { beforeAll, expect, test } from 'bun:test';

import type { VitalsSample } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';
import { SQL } from 'bun';

import { nextSteps } from '../../dashboard/src/lib/attention.ts';
import { readAttention } from '../../dashboard/src/server/attention.ts';
import { parseConditionLimits } from './condition-limits.ts';
import { evaluateConditions } from './evaluate-conditions.ts';
import { evaluateLoadConditions, judgeLoadConditions } from './load-conditions.ts';
import type { LoadConditionFacts } from './load-conditions.ts';
import { holdersAt, holdersText } from './memory-holders.ts';
import { unpair } from './pairing.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { NOW, push, report, startHub, storeToken } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { startTestServer } from './testing/postgres.ts';

beforeAll(startTestServer, 60_000);

const MINUTE = 60_000;
const STEP = 15_000;

const readings = (from: number, minutes: number, cpu: (minute: number) => number): VitalsSample[] =>
  Array.from({ length: minutes * 4 + 1 }, (_, i) => ({
    ...sample(from + i * STEP),
    cpu: { busyPercent: cpu(i / 4) },
    uptimeSeconds: (from - NOW + i * STEP) / 1000 + 1000,
  }));

const send = async (h: Hub, samples: VitalsSample[], platform: 'darwin' | 'linux' = 'linux') => {
  const last = samples.at(-1);
  if (last === undefined) {
    throw new Error('The fixture needs readings.');
  }
  h.clock.now = Math.max(h.clock.now, last.t);
  const body = { ...report('laptop-1', []), samples, sentAt: h.clock.now };
  body.collector.platform = platform;
  expect((await push(h.hub, body, { token: 'laptop-token' })).status).toBe(200);
};

const evaluate = async (h: Hub, limits = parseConditionLimits(undefined)) => {
  await evaluateConditions(h.db.sql, () => h.clock.now, {
    ...SYSTEM_CONDITION_THRESHOLDS,
    ...limits,
  });
  return (
    await readAttention(h.db.sql, {
      now: h.clock.now,
      systems: [{ name: 'laptop-1', paired: true }],
    })
  ).filter(
    (item) =>
      item.system === 'laptop-1' && (item.kind === 'high_cpu' || item.kind === 'high_memory'),
  );
};

// The same Collector readings as plain database facts, without storing them.
const loadFacts = (
  samples: VitalsSample[],
  overrides: Partial<LoadConditionFacts> = {},
): LoadConditionFacts => ({
  backfilled: [],
  held: [],
  limits: parseConditionLimits(undefined),
  rows: samples.map((row) => ({
    collector_platform: 'linux',
    cpu_busy_percent: row.cpu.busyPercent,
    memory_pressure: row.memory.pressure ?? null,
    memory_total_bytes: String(row.memory.totalBytes),
    memory_used_bytes: String(row.memory.usedBytes),
    t: new Date(row.t),
    uptime_seconds: row.uptimeSeconds,
  })),
  through: undefined,
  ...overrides,
});

const judgedLoad = (facts: LoadConditionFacts, now = facts.rows.at(-1)?.t.getTime() ?? NOW) =>
  judgeLoadConditions(facts, now);

// Flush this connection's table counters before reading them from a new snapshot.
const vitalsReads = async (sql: SQL) => {
  await sql`SELECT pg_stat_force_next_flush()`;
  await sql`SELECT pg_stat_clear_snapshot()`;
  const [row]: { reads: string }[] = await sql`
    SELECT (seq_tup_read + idx_tup_fetch)::text AS reads
    FROM pg_stat_user_tables WHERE relname = 'vitals_samples'
  `;
  return Number(row?.reads ?? 0);
};

test('idle load evaluations read at most the latest eligible sample across connections', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 240, () => 95),
  );
  const limits = parseConditionLimits(undefined);
  await evaluate(h, limits);
  // A visibility map can let the newest-sample lookup avoid heap fetches too.
  await h.db.sql`VACUUM vitals_samples`;
  // A fresh pool also proves the skip survives a Hub restart. One connection
  // keeps all table counters on the backend whose statistics we flush.
  await using sql = new SQL({ max: 1, url: h.db.url.href });
  const before = await vitalsReads(sql);
  h.clock.now += MINUTE;
  await evaluateLoadConditions(sql, () => h.clock.now, limits);
  expect((await vitalsReads(sql)) - before).toBeLessThanOrEqual(1);
  const unchanged = await vitalsReads(sql);
  await evaluateLoadConditions(
    sql,
    () => h.clock.now,
    parseConditionLimits({
      disk: { note: 71 },
      process: { cores: 2 },
      systems: { 'laptop-1': { updates: { rebootWarningDays: 10 } } },
    }),
  );
  expect((await vitalsReads(sql)) - unchanged).toBeLessThanOrEqual(1);
  expect((await evaluate(h, limits))[0]?.level).toBe('warning');
});

test('recurring CPU bursts raise a note even when the newest reading is quiet', () => {
  const facts = loadFacts(
    readings(NOW, 60, (minute) => (minute <= 20 || (minute > 25 && minute <= 45) ? 95 : 10)),
  );
  expect(judgedLoad(facts).transitions.at(-1)).toEqual({
    at: new Date(NOW + 60 * MINUTE),
    kind: 'high_cpu',
    verdict: {
      level: 'note',
      raise: 'CPU above 90% for 40 minutes in the 60 minutes ending 2026-10-06T13:00:00.000Z.',
    },
  });
});

test('CPU boundaries escalate and short spikes or equality do not qualify', () => {
  const equal = readings(NOW, 30, () => 90);
  const short = readings(NOW + 30 * MINUTE, 29.75, () => 95);
  expect(judgedLoad(loadFacts(equal)).transitions).toEqual([]);
  expect(judgedLoad(loadFacts([...equal, ...short])).transitions).toEqual([]);
  const busy = readings(NOW + 60 * MINUTE, 90, () => 95);
  const facts = loadFacts([
    ...equal,
    ...short,
    ...readings(NOW + 59.75 * MINUTE, 0.25, () => 95),
    ...busy,
  ]);
  const transitions = judgedLoad(facts).transitions;
  expect(transitions[0]).toMatchObject({
    at: new Date(NOW + 60 * MINUTE),
    kind: 'high_cpu',
    verdict: { level: 'note' },
  });
  expect(transitions.at(-1)).toMatchObject({
    at: new Date(NOW + 150 * MINUTE),
    kind: 'high_cpu',
    verdict: { level: 'warning' },
  });
});

test('memory warns only on supported high-memory evidence', () => {
  for (const [platform, usedBytes, pressure, expected] of [
    ['linux', 950, null, true],
    ['linux', 750, null, false],
    ['darwin', 950, 'normal', false],
    ['darwin', 950, 'critical', true],
    ['darwin', 950, null, false],
  ] satisfies ['linux' | 'darwin', number, VitalsSample['memory']['pressure'] | null, boolean][]) {
    const facts = loadFacts(readings(NOW, 30, () => 10));
    facts.rows = facts.rows.map((row) => ({
      ...row,
      collector_platform: platform,
      memory_pressure: pressure,
      memory_total_bytes: '1000',
      memory_used_bytes: String(usedBytes),
    }));
    expect(
      judgedLoad(facts).transitions.map(({ kind, verdict }) => [
        kind,
        verdict === 'clear' ? verdict : verdict.level,
      ]),
    ).toEqual(expected ? [['high_memory', 'warning']] : []);
  }
});

test('sleep, reboot, and future samples cannot invent enough measured busy time', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 10, () => 95),
  );
  await send(
    h,
    readings(NOW + 40 * MINUTE, 10, () => 95),
  );
  expect(await evaluate(h)).toEqual([]);
  const reboot = readings(NOW + 50 * MINUTE, 0, () => 95).map((row) =>
    Object.assign(row, {
      uptimeSeconds: 1,
    }),
  );
  await send(h, reboot);
  const future = readings(NOW + 10 * 60 * MINUTE, 30, () => 95);
  const saved = h.clock.now;
  await send(h, future);
  h.clock.now = saved;
  expect(await evaluate(h)).toEqual([]);
});

test('a cached quiet window is rejudged when future samples become eligible', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 30, () => 10),
  );
  expect(await evaluate(h)).toEqual([]);
  const quietAt = h.clock.now;
  await send(
    h,
    readings(NOW + 120 * MINUTE, 30, () => 95),
  );
  const futureAt = h.clock.now;
  h.clock.now = quietAt;
  expect(await evaluate(h)).toEqual([]);
  h.clock.now = futureAt;
  expect((await evaluate(h))[0]).toMatchObject({ kind: 'high_cpu', level: 'note' });
});

test('a clock rollback rejudges cached old load evidence when it becomes fresh', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 30, () => 95),
  );
  const latestAt = h.clock.now;
  h.clock.now += 8 * 60 * MINUTE;
  expect(await evaluate(h)).toEqual([]);
  h.clock.now = latestAt + MINUTE;
  expect((await evaluate(h))[0]).toMatchObject({ kind: 'high_cpu', level: 'note' });
});

test('changed memory limits rejudge cached evidence independently of CPU limits', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 30, () => 10).map((row) =>
      Object.assign(row, {
        memory: { totalBytes: 1000, usedBytes: 850 },
      }),
    ),
  );
  expect(await evaluate(h)).toEqual([]);
  const configured = parseConditionLimits({ memory: { percent: 80 } });
  expect((await evaluate(h, configured))[0]).toMatchObject({
    kind: 'high_memory',
    level: 'warning',
  });
});

test('silence holds warning; fresh recovery clears it and recurrence has a new occurrence', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 120, () => 95),
  );
  const [warning] = await evaluate(h);
  expect(warning?.level).toBe('warning');
  if (warning === undefined) {
    throw new Error('Expected the warning.');
  }
  expect(nextSteps(warning).short).toBe('Find what keeps using CPU');
  h.clock.now += 6 * 60 * MINUTE;
  expect((await evaluate(h))[0]?.level).toBe('warning');
  await send(
    h,
    readings(h.clock.now, 121, () => 10),
  );
  expect(await evaluate(h)).toEqual([]);
  const quiet = h.clock.now;
  await send(
    h,
    readings(quiet, 30, () => 95),
  );
  const [again] = await evaluate(h);
  expect(again?.level).toBe('note');
  expect(again?.firstDetected).toBeGreaterThan(warning?.firstDetected ?? 0);
});

test('a recovered episode in delayed Reports is recorded once across separate evaluation passes', async () => {
  await using h = await startHub();
  const samples = readings(NOW, 91, (minute) => (minute <= 30 ? 95 : 10));
  await send(h, samples);
  expect(await evaluate(h)).toEqual([]);
  const rows: { kind: string; cleared_at: Date | null }[] = await h.db.sql`
    SELECT kind, cleared_at FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(rows).toEqual([{ cleared_at: new Date(h.clock.now), kind: 'high_cpu' }]);
  await send(h, samples);
  await evaluate(h);
  const count: { n: number }[] = await h.db
    .sql`SELECT count(*)::int AS n FROM conditions WHERE kind = 'high_cpu'`;
  expect(count).toEqual([{ n: 1 }]);
});

test('per-System limits change the next judgment and unpairing withdraws load Conditions', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 20, () => 85),
  );
  expect(await evaluate(h)).toEqual([]);
  const configured = parseConditionLimits({
    systems: { 'laptop-1': { cpu: { noteMinutes: 20, percent: 80 } } },
  });
  expect((await evaluate(h, configured))[0]?.level).toBe('note');
  await unpair(h.db.sql, 'laptop-1');
  expect(await evaluate(h, configured)).toEqual([]);
});

test('re-pairing rejudges unchanged load evidence after withdrawal', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 120, () => 95),
  );
  const [first] = await evaluate(h);
  expect(first?.level).toBe('warning');
  await unpair(h.db.sql, 'laptop-1');
  expect(await evaluate(h)).toEqual([]);
  await storeToken(h.db.sql, {
    pairedAt: NOW,
    system: 'laptop-1',
    token: 'laptop-token',
  });
  h.clock.now += MINUTE;
  const [next] = await evaluate(h);
  expect(next?.level).toBe('warning');
  expect(next?.firstDetected).not.toBe(first?.firstDetected);
});

test('macOS memory without pressure, at any usage and for longer than the window, holds the warning with unknown evidence', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 30, () => 10).map((row) =>
      Object.assign(row, {
        memory: { pressure: 'warning', totalBytes: 1000, usedBytes: 950 },
      }),
    ),
    'darwin',
  );
  expect((await evaluate(h))[0]?.level).toBe('warning');
  await send(
    h,
    readings(h.clock.now, 61, () => 10).map((row) =>
      Object.assign(row, {
        memory: { totalBytes: 1000, usedBytes: 950 },
      }),
    ),
    'darwin',
  );
  expect(await evaluate(h)).toEqual([
    expect.objectContaining({
      evidence: 'unknown',
      kind: 'high_memory',
      level: 'warning',
    }),
  ]);
  const low = readings(h.clock.now + STEP, 0, () => 10);
  for (const row of low) {
    row.memory = { totalBytes: 1000, usedBytes: 100 };
  }
  await send(h, low, 'darwin');
  expect((await evaluate(h))[0]?.evidence).toBe('unknown');
});

test('a zero memory total preserves the warning and shows unknown evidence', async () => {
  await using h = await startHub();
  const samples = readings(NOW, 30, () => 10);
  for (const row of samples) {
    row.memory = { totalBytes: 1000, usedBytes: 950 };
  }
  await send(h, samples);
  expect((await evaluate(h))[0]?.level).toBe('warning');
  const unknown = readings(h.clock.now + STEP, 0, () => 10);
  for (const row of unknown) {
    row.memory = { totalBytes: 0, usedBytes: 0 };
  }
  await send(h, unknown);
  expect(await evaluate(h)).toEqual([
    expect.objectContaining({
      evidence: 'unknown',
      kind: 'high_memory',
      level: 'warning',
    }),
  ]);
});

test('an unseen completed episode arriving behind a newer quiet sample is backfilled once', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW + 120 * MINUTE, 0, () => 10),
  );
  expect(await evaluate(h)).toEqual([]);
  const delayed = readings(NOW, 91, (minute) => (minute <= 30 ? 95 : 10));
  await send(h, delayed);
  expect(await evaluate(h)).toEqual([]);
  const found: { kind: string; cleared_at: Date | null }[] = await h.db.sql`
    SELECT kind, cleared_at FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(found).toEqual([{ cleared_at: new Date(h.clock.now), kind: 'high_cpu' }]);
  await send(h, delayed);
  await evaluate(h);
  const count: { n: number }[] = await h.db
    .sql`SELECT count(*)::int AS n FROM conditions WHERE kind = 'high_cpu'`;
  expect(count).toEqual([{ n: 1 }]);
});

test('historical replay preserves a later open occurrence and does not duplicate overlapping history', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW + 120 * MINUTE, 0, () => 10),
  );
  await evaluate(h);
  await send(
    h,
    readings(NOW + 300 * MINUTE, 30, () => 95),
  );
  const [current] = await evaluate(h);
  expect(current?.level).toBe('note');
  await send(
    h,
    readings(NOW, 91, (minute) => (minute <= 30 ? 95 : 10)),
  );
  expect((await evaluate(h))[0]?.firstDetected).toBe(current?.firstDetected);
  await send(
    h,
    readings(NOW + STEP / 2, 0, () => 95),
  );
  expect((await evaluate(h))[0]?.firstDetected).toBe(current?.firstDetected);
  const rows: { n: number; open: number }[] = await h.db.sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE cleared_at IS NULL)::int AS open
    FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(rows).toEqual([{ n: 2, open: 1 }]);
});

test('recovery rules out each lower level before clearing when the last hour contains a gap', () => {
  const facts = loadFacts([
    ...readings(NOW, 120, () => 95),
    ...readings(NOW + 120 * MINUTE, 95, () => 10),
    ...readings(NOW + 255 * MINUTE, 25.25, () => 10),
  ]);
  expect(judgedLoad(facts).transitions.at(-1)).toMatchObject({
    kind: 'high_cpu',
    verdict: { level: 'note' },
  });
});

test('an entirely old backlog records separate completed episodes without creating a current problem', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 241, (minute) =>
      (minute > 0 && minute <= 40) || (minute > 150 && minute <= 190) ? 95 : 10,
    ),
  );
  h.clock.now += 3 * 60 * MINUTE;
  expect(await evaluate(h)).toEqual([]);
  const rows: { n: number; open: number }[] = await h.db.sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE cleared_at IS NULL)::int AS open
    FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(rows).toEqual([{ n: 2, open: 0 }]);
});

test('macOS memory pressure warns at any usage and names pressure in its reason', () => {
  const facts = loadFacts(readings(NOW, 30, () => 10));
  facts.rows = facts.rows.map((row) => ({
    ...row,
    collector_platform: 'darwin',
    memory_pressure: 'warning',
    memory_total_bytes: '1000',
    memory_used_bytes: '500',
  }));
  expect(judgedLoad(facts).transitions).toEqual([
    {
      at: new Date(NOW + 30 * MINUTE),
      kind: 'high_memory',
      verdict: {
        level: 'warning',
        raise: 'Memory pressure for 30 minutes in the 60 minutes ending 2026-10-06T12:30:00.000Z.',
      },
    },
  ]);
});

test('a fresh sample after sleep holds CPU level while its latest interval is unknown', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 30, () => 95),
  );
  await evaluate(h);
  await send(
    h,
    readings(NOW + 120 * MINUTE, 0, () => 10),
  );
  expect(await evaluate(h)).toEqual([
    expect.objectContaining({
      evidence: 'unknown',
      kind: 'high_cpu',
      level: 'note',
    }),
  ]);
});

test('several old backlog batches preserve separate episodes without raising a current Condition', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 60, (minute) => (minute <= 40 ? 95 : 10)),
  );
  h.clock.now = NOW + 8 * 60 * MINUTE;
  expect(await evaluate(h)).toEqual([]);
  await send(
    h,
    readings(NOW + 60 * MINUTE, 181, (minute) => (minute > 90 && minute <= 130 ? 95 : 10)),
  );
  expect(await evaluate(h)).toEqual([]);
  const rows: { n: number; open: number }[] = await h.db.sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE cleared_at IS NULL)::int AS open
    FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(rows).toEqual([{ n: 2, open: 0 }]);
});

test('a far-future sample does not hide the load evidence the Hub actually judged', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 30, () => 95),
  );
  await evaluate(h);
  const judgedAt = h.clock.now;
  await send(
    h,
    readings(NOW + 24 * 60 * MINUTE, 0, () => 10),
  );
  h.clock.now = judgedAt;
  expect(await evaluate(h)).toEqual([
    expect.objectContaining({
      checkedAt: judgedAt,
      evidence: 'current',
      kind: 'high_cpu',
      level: 'note',
    }),
  ]);
});

test('an incomplete old episode survives until fresh quiet samples establish its historical recovery', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW, 60, (minute) => (minute <= 40 ? 95 : 10)),
  );
  h.clock.now = NOW + 8 * 60 * MINUTE;
  expect(await evaluate(h)).toEqual([]);
  await send(
    h,
    readings(NOW + 8 * 60 * MINUTE, 61, () => 10),
  );
  expect(await evaluate(h)).toEqual([]);
  const rows: { n: number; open: number }[] = await h.db.sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE cleared_at IS NULL)::int AS open
    FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(rows).toEqual([{ n: 1, open: 0 }]);
});

test('a delayed episode held at the dirty replay cutoff survives into a later fresh batch', async () => {
  await using h = await startHub();
  await send(
    h,
    readings(NOW + 95 * MINUTE, 5, () => 10),
  );
  await evaluate(h);
  await send(
    h,
    readings(NOW, 40, (minute) => (minute <= 35 ? 95 : 10)),
  );
  await evaluate(h);
  await send(
    h,
    readings(NOW + 100 * MINUTE, 120, () => 10),
  );
  expect(await evaluate(h)).toEqual([]);
  const rows: { n: number; open: number }[] = await h.db.sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE cleared_at IS NULL)::int AS open
    FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(rows).toEqual([{ n: 1, open: 0 }]);
});

test('a Collector drain split at its 1000-sample Report limit preserves an episode across sleep', async () => {
  await using h = await startHub();
  const queued = [
    ...readings(NOW, 220, (minute) => (minute > 170 && minute <= 210 ? 95 : 10)),
    ...readings(NOW + 280 * MINUTE, 200, () => 10),
  ];
  await send(h, queued.slice(0, 1000));
  h.clock.now = NOW + 480 * MINUTE;
  await evaluate(h);
  await send(h, queued.slice(1000));
  expect(await evaluate(h)).toEqual([]);
  const rows: { n: number; open: number }[] = await h.db.sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE cleared_at IS NULL)::int AS open
    FROM conditions WHERE kind = 'high_cpu'
  `;
  expect(rows).toEqual([{ n: 1, open: 0 }]);
});

test.each([
  ['dirty', 0, 1],
  ['dirty', 40, 2],
  ['memory', 0, 1],
] satisfies ['dirty' | 'memory', number, number][])(
  '%s replay with %d quiet minutes counts each live CPU episode once',
  async (trigger, quiet, expected) => {
    await using h = await startHub();
    await send(
      h,
      readings(NOW, 40, () => 95),
    );
    await evaluate(h);
    const old = readings(NOW + 40 * MINUTE, 60, () => 10);
    if (trigger === 'memory') {
      for (const row of old) {
        if (row.t > NOW + 60 * MINUTE) {
          row.memory = { totalBytes: 1000, usedBytes: 950 };
        }
      }
    }
    await send(h, old);
    h.clock.now = NOW + 480 * MINUTE;
    expect((await evaluate(h))[0]?.level).toBe('note');
    if (trigger === 'dirty') {
      await send(
        h,
        readings(NOW + 70.1 * MINUTE, 0, () => 10),
      );
    }
    await send(
      h,
      readings(NOW + 480 * MINUTE, quiet + 100, (minute) =>
        minute > quiet && minute <= quiet + 35 ? 95 : 10,
      ),
    );
    expect(await evaluate(h)).toEqual([]);
    const rows: { n: number; open: number }[] = await h.db.sql`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE cleared_at IS NULL)::int AS open
      FROM conditions WHERE kind = 'high_cpu'
    `;
    expect(rows).toEqual([{ n: expected, open: 0 }]);
  },
);

test('a judge with no readings has no transitions or known intervals', () => {
  expect(judgedLoad(loadFacts([]))).toEqual({
    coverage: { cpuKnown: false, memoryKnown: false },
    transitions: [],
  });
});

test('sleep and reboot leave intervals unknown instead of inventing measured busy time', () => {
  const facts = loadFacts([
    ...readings(NOW, 10, () => 95),
    ...readings(NOW + 40 * MINUTE, 10, () => 95),
    ...readings(NOW + 50 * MINUTE + STEP, 0, () => 95).map((row) =>
      Object.assign(row, { uptimeSeconds: 1 }),
    ),
  ]);
  expect(judgedLoad(facts)).toEqual({
    coverage: { cpuKnown: false, memoryKnown: false },
    transitions: [],
  });
});

const GIB = 2 ** 30;
const holder = (name: string, rssBytes: number) => ({ name, pid: 1, rssBytes, start: 'a' });

// Linux memory at 95% for an hour, or macOS pressure; `carrying` picks which
// samples carry a holders list.
const memoryFacts = (
  platform: 'darwin' | 'linux',
  carrying: (t: number, minute: number) => ReturnType<typeof holder>[] | null,
) => {
  const facts = loadFacts(readings(NOW, 60, () => 5));
  for (const [i, row] of facts.rows.entries()) {
    Object.assign(row, {
      collector_platform: platform,
      memory_pressure: platform === 'darwin' ? 'critical' : null,
      memory_total_bytes: String(16 * GIB),
      memory_used_bytes: String(15.2 * GIB),
      top_by_memory: carrying(row.t.getTime(), i / 4),
    });
  }
  return facts;
};

const memoryReason = (facts: LoadConditionFacts) => {
  const verdict = judgedLoad(facts).transitions.findLast(
    (transition) => transition.kind === 'high_memory',
  )?.verdict;
  return typeof verdict === 'object' ? verdict.raise : undefined;
};

const THREE = [
  holder('postgres', 3.1 * GIB),
  holder('node', 1.2 * GIB),
  holder('bun', 800 * 2 ** 20),
];
const PLAIN = /^Memory above 90% for [\d.]+ minutes in the 60 minutes ending \S+Z\.$/;

test('a raised High memory reason names the largest processes, largest first', () => {
  const reason = memoryReason(memoryFacts('linux', (_, m) => (m % 1 === 0 ? THREE : null)));
  expect(reason).toMatch(
    /^Memory above 90% for [\d.]+ minutes in the 60 minutes ending \S+Z; largest: postgres 3\.1 GiB, node 1\.2 GiB, bun 800 MiB\.$/,
  );
  expect(reason?.match(/\.$/g)).toHaveLength(1);
});

test('macOS pressure wording keeps its prefix and names the holders', () => {
  const reason = memoryReason(memoryFacts('darwin', () => THREE));
  expect(reason).toMatch(
    /^Memory pressure for [\d.]+ minutes in the .* ending \S+Z; largest: postgres 3\.1 GiB/,
  );
});

test('without a qualifying list the High memory reason is the plain sentence', () => {
  expect(memoryReason(memoryFacts('linux', () => null))).toMatch(PLAIN);
  expect(memoryReason(memoryFacts('linux', () => []))).toMatch(PLAIN);
  // A list only from the first minutes is far older than two minutes at the raise.
  expect(memoryReason(memoryFacts('linux', (_, m) => (m === 0 ? THREE : null)))).toMatch(PLAIN);
});

test('holders from before the boot or too long ago are not used', () => {
  const facts = memoryFacts('linux', (_, m) => (m === 0 ? THREE : null));
  expect(holdersAt(facts.rows, 8)).toHaveLength(3);
  expect(holdersAt(facts.rows, 9)).toEqual([]);
  // Rebooted 20 seconds before row 4: the carrier at row 0 is from the old boot.
  const rebooted = memoryFacts('linux', (_, m) => (m === 0 ? THREE : null)).rows;
  Object.assign(rebooted[4] ?? {}, { uptime_seconds: 20 });
  expect(holdersAt(rebooted, 4)).toEqual([]);
});

test('High CPU reasons never name memory holders', () => {
  const facts = loadFacts(readings(NOW, 60, () => 95));
  for (const row of facts.rows) {
    Object.assign(row, { top_by_memory: THREE });
  }
  const verdicts = judgedLoad(facts).transitions.filter((t) => t.kind === 'high_cpu');
  expect(verdicts.length).toBeGreaterThan(0);
  for (const { verdict } of verdicts) {
    expect(typeof verdict === 'object' ? verdict.raise : '').not.toContain('largest');
  }
});

test("long process names are cut, keeping Activity's line readable", () => {
  const long = Array.from({ length: 5 }, (_, i) =>
    holder(`${'x'.repeat(80)}${String(i)}`, 2 * GIB),
  );
  const reason = memoryReason(memoryFacts('linux', () => long)) ?? '';
  expect(reason).toContain('largest:');
  expect(reason).not.toContain('x'.repeat(31));
});

test('a name is cut by code point, never inside a surrogate pair', () => {
  const name = `${'a'.repeat(28)}😀zz`;
  const text = holdersText([holder(name, 2 * GIB)]);
  expect(text).toBe(`${'a'.repeat(28)}😀… 2.0 GiB`);
  expect(text.isWellFormed()).toBe(true);
  expect(holdersText([holder(`${'a'.repeat(29)}😀zz`, 2 * GIB)]).isWellFormed()).toBe(true);
});

test('the newest carrier decides: an empty list means no holders, not older ones', () => {
  const facts = memoryFacts('linux', (_, m) => {
    if (m === 59) {
      return THREE;
    }
    return m === 60 ? [] : null;
  });
  expect(holdersAt(facts.rows, facts.rows.length - 1)).toEqual([]);
  expect(memoryReason(facts)).toMatch(PLAIN);
});

test('windows shorter than two minutes still find a list from 1:30 earlier', async () => {
  await using h = await startHub();
  // Every window is under two minutes, so only the carrier floor reaches the list.
  const limits = parseConditionLimits({
    cpu: {
      noteMinutes: 0.25,
      noteWindowMinutes: 0.25,
      warningMinutes: 0.5,
      warningWindowMinutes: 0.5,
    },
    memory: { percent: 90, warningMinutes: 0.25, warningWindowMinutes: 0.5 },
  });
  const quiet = readings(NOW, 10, () => 10).map((row, i) =>
    Object.assign(row, {
      memory: { totalBytes: 1000, usedBytes: 100 },
      ...(i === 35 ? { processes: holderObservation() } : {}),
    }),
  );
  await send(h, quiet);
  await evaluate(h, limits);
  // The raise lands 1:30 after the only carrier, before the next read's start.
  await send(
    h,
    readings(NOW + 10 * MINUTE + STEP, 1, () => 10).map((row) =>
      Object.assign(row, { memory: { totalBytes: 1000, usedBytes: 950 } }),
    ),
  );
  await evaluate(h, limits);
  const [row]: { reason: string }[] = await h.db.sql`
    SELECT raised_reason AS reason FROM conditions WHERE kind = 'high_memory' AND system = 'laptop-1'
  `;
  expect(row?.reason).toContain('; largest: postgres 3.1 GiB');
});

test('a backfilled High memory episode names the holders its samples carried', async () => {
  await using h = await startHub();
  const limits = parseConditionLimits({
    memory: { percent: 90, warningMinutes: 5, warningWindowMinutes: 10 },
  });
  await send(
    h,
    readings(NOW + 120 * MINUTE, 0, () => 10),
  );
  await evaluate(h, limits);
  const delayed = readings(NOW, 60, () => 10).map((row, i) =>
    Object.assign(row, {
      memory: { totalBytes: 1000, usedBytes: i <= 4 * 20 ? 950 : 100 },
      processes: holderObservation(),
    }),
  );
  await send(h, delayed);
  await evaluate(h, limits);
  const found: { reason: string; cleared: boolean }[] = await h.db.sql`
    SELECT raised_reason AS reason, cleared_at IS NOT NULL AS cleared
    FROM conditions WHERE kind = 'high_memory' AND system = 'laptop-1'
  `;
  expect(found).toHaveLength(1);
  expect(found[0]?.cleared).toBe(true);
  expect(found[0]?.reason).toContain('; largest: postgres 3.1 GiB');
});

const holderObservation = () => ({
  bootId: 'boot-1',
  census: { kind: 'partial' as const },
  intervalMs: 15_000,
  top: [],
  topByMemory: [
    { name: 'postgres', pid: 7, rssBytes: Math.round(3.1 * GIB), start: '1' },
    { name: 'node', pid: 8, rssBytes: Math.round(1.2 * GIB), start: '2' },
  ],
});

test('the stored High memory reason names the holders read from the database', async () => {
  await using h = await startHub();
  const samples = readings(NOW, 30, () => 10).map((row, i) =>
    Object.assign(row, {
      memory: { totalBytes: 1000, usedBytes: 950 },
      ...(i % 4 === 0 ? { processes: holderObservation() } : {}),
    }),
  );
  await send(h, samples);
  await evaluate(h);
  const [row]: { reason: string }[] = await h.db.sql`
    SELECT latest_reason AS reason FROM conditions WHERE kind = 'high_memory' AND system = 'laptop-1'
  `;
  expect(row?.reason).toMatch(/; largest: postgres 3\.1 GiB, node 1\.2 GiB\.$/);
});
