import { beforeAll, describe, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { hubStatusRecorder, STATUS_LOCK_TIMEOUT_MS } from './hub-status.ts';
import type { PassRecord } from './hub-status.ts';
import { migrate } from './migrations.ts';
import { PASS_SCHEDULES } from './serve.ts';
import { configArgs, configFile, hubConfig, invoke } from './testing/cli.ts';
import { startHub } from './testing/hub.ts';
import { startTestServer, testDatabase } from './testing/postgres.ts';
import { HUB_VERSION } from './version.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

const T0 = 1_800_000_000_000;
const SCHEDULE = { conditions: { budgetMs: 30_000, intervalMs: 60_000 } };

const statusRow = async (sql: SQL) => {
  const [row]: {
    version: string;
    started_at: Date;
    delivery_configured: boolean;
    last_runs: Record<string, PassRecord>;
  }[] = await sql`SELECT version, started_at, delivery_configured, last_runs FROM hub_status`;
  return row;
};

const recorder = (sql: SQL, clock: { now: number }, warnings: string[] = []) =>
  hubStatusRecorder({
    now: () => clock.now,
    sql,
    warn: (message) => {
      warnings.push(message);
    },
  });

describe('the status recorder', () => {
  test('start stores the version, start time, delivery flag, and each pass schedule, replacing the last process', async () => {
    await using h = await startHub();
    const clock = { now: T0 };
    const status = recorder(h.db.sql, clock);
    await status.start({ deliveryConfigured: true, passes: SCHEDULE, version: 'test-version' });
    await status.pass('conditions', async () => {});
    expect(await statusRow(h.db.sql)).toMatchObject({
      delivery_configured: true,
      started_at: new Date(T0),
      version: 'test-version',
    });
    await status.start({
      deliveryConfigured: false,
      passes: { prune: { budgetMs: 1, intervalMs: 2 } },
      version: 'next',
    });
    expect((await statusRow(h.db.sql))?.last_runs).toEqual({
      prune: { budget_ms: 1, interval_ms: 2 },
    });
  });

  test('a pass records when it started before its work runs, then when it finished and succeeded', async () => {
    await using h = await startHub();
    const clock = { now: T0 };
    const status = recorder(h.db.sql, clock);
    await status.start({ deliveryConfigured: false, passes: SCHEDULE, version: 'test' });
    let during: PassRecord | undefined;
    await status.pass('conditions', async () => {
      during = (await statusRow(h.db.sql))?.last_runs.conditions;
      clock.now = T0 + 1234;
    });
    expect(during).toEqual({ budget_ms: 30_000, interval_ms: 60_000, started_at: T0 });
    expect((await statusRow(h.db.sql))?.last_runs.conditions).toEqual({
      budget_ms: 30_000,
      finished_at: T0 + 1234,
      interval_ms: 60_000,
      started_at: T0,
      succeeded_at: T0 + 1234,
    });
  });

  test('a pass that keeps failing keeps the time of its first failure, and a success clears it', async () => {
    await using h = await startHub();
    const clock = { now: T0 };
    const status = recorder(h.db.sql, clock);
    await status.start({ deliveryConfigured: false, passes: SCHEDULE, version: 'test' });
    await status.pass('conditions', async () => {});
    for (const at of [T0 + 60_000, T0 + 120_000]) {
      clock.now = at;
      // oxlint-disable-next-line no-await-in-loop -- one failing run after another.
      const error = await status
        .pass('conditions', async () => {
          throw new Error('judgment failed');
        })
        .catch((thrown: unknown) => thrown);
      expect(error).toEqual(new Error('judgment failed'));
    }
    expect((await statusRow(h.db.sql))?.last_runs.conditions).toMatchObject({
      failing_since: T0 + 60_000,
      finished_at: T0 + 120_000,
      started_at: T0 + 120_000,
      succeeded_at: T0,
    });
    clock.now = T0 + 180_000;
    await status.pass('conditions', async () => {});
    const run = (await statusRow(h.db.sql))?.last_runs.conditions;
    expect(run?.failing_since).toBeUndefined();
    expect(run?.succeeded_at).toBe(T0 + 180_000);
  });

  test('a failed status write warns without failing startup or a timer pass', async () => {
    await using h = await startHub();
    await h.db.sql`DROP TABLE hub_status`;
    const warnings: string[] = [];
    const status = recorder(h.db.sql, { now: 123 }, warnings);
    await status.start({ deliveryConfigured: false, passes: SCHEDULE, version: 'test' });
    let ran = false;
    await status.pass('prune', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toStartWith('Could not record Hub status: ');
  });

  test('a row another session holds costs a pass at most the lock timeout, logged, and the pass still runs', async () => {
    expect(STATUS_LOCK_TIMEOUT_MS).toBe(1000);
    await using h = await startHub();
    const clock = { now: T0 };
    const warnings: string[] = [];
    const status = recorder(h.db.sql, clock, warnings);
    await status.start({ deliveryConfigured: false, passes: SCHEDULE, version: 'test' });
    const holder = await h.db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT * FROM hub_status FOR UPDATE`;
      let ran = false;
      const began = performance.now();
      await status.pass('conditions', async () => {
        ran = true;
      });
      const took = performance.now() - began;
      expect(ran).toBe(true);
      // Two writes, each waiting out the lock timeout, well inside the
      // statement timeout the write would otherwise wait for.
      expect(took).toBeGreaterThanOrEqual(2 * STATUS_LOCK_TIMEOUT_MS - 50);
      expect(took).toBeLessThan(2 * STATUS_LOCK_TIMEOUT_MS + 2000);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('lock timeout');
    } finally {
      await holder`ROLLBACK`;
      await holder.release();
    }
  }, 15_000);
});

test('each pass schedule is its timer interval and the longest one run is meant to take', () => {
  expect(PASS_SCHEDULES).toEqual({
    conditions: { budgetMs: 30_000, intervalMs: 60_000 },
    delivery: { budgetMs: 30_000, intervalMs: 30_000 },
    listening: { budgetMs: 30_000, intervalMs: 30_000 },
    parse: { budgetMs: 30_000, intervalMs: 15_000 },
    prune: { budgetMs: 30_000, intervalMs: 3_600_000 },
    refresh: { budgetMs: 40_000, intervalMs: 15_000 },
    upstreams: { budgetMs: 30_000, intervalMs: 300_000 },
  });
});

describe('serve', () => {
  test('writes the start row once it listens, and every pass, delivery included, records its run', async () => {
    await using db = await testDatabase();
    await using config = await hubConfig(db, [
      '[delivery]',
      'url = "http://127.0.0.1:1/"',
      'topic = "heimdall-x7Qp"',
      'dashboard = "https://dashboard.example/"',
    ]);
    let runs: Record<string, PassRecord> = {};
    let row: Awaited<ReturnType<typeof statusRow>>;
    const { code } = await invoke(['serve', ...configArgs(config)], {
      whileServing: async () => {
        for (let tries = 0; tries < 200; tries += 1) {
          // oxlint-disable-next-line no-await-in-loop -- polls until every pass has run once.
          row = await statusRow(db.sql);
          runs = row?.last_runs ?? {};
          if (Object.values(runs).filter((run) => run.finished_at !== undefined).length === 7) {
            return;
          }
          // oxlint-disable-next-line no-await-in-loop -- polls until every pass has run once.
          await Bun.sleep(20);
        }
      },
    });
    expect(code).toBe(130);
    expect(row).toMatchObject({ delivery_configured: true, version: HUB_VERSION });
    expect(Object.keys(runs).toSorted()).toEqual(Object.keys(PASS_SCHEDULES).toSorted());
    for (const [name, { budgetMs, intervalMs }] of Object.entries(PASS_SCHEDULES)) {
      expect(runs[name]).toMatchObject({ budget_ms: budgetMs, interval_ms: intervalMs });
      expect(runs[name]?.finished_at).toBeNumber();
      expect(runs[name]?.started_at).toBeNumber();
    }
  });

  test('records no delivery pass when delivery is not configured', async () => {
    await using db = await testDatabase();
    await using config = await hubConfig(db);
    let row: Awaited<ReturnType<typeof statusRow>>;
    await invoke(['serve', ...configArgs(config)], {
      whileServing: async () => {
        row = await statusRow(db.sql);
      },
    });
    expect(row?.delivery_configured).toBe(false);
    expect(Object.keys(row?.last_runs ?? {})).not.toContain('delivery');
  });

  test('a Hub that cannot listen leaves the running Hub status row as it was', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);
    const live = { prune: { budget_ms: 1, interval_ms: 2, started_at: T0 } };
    await db.sql`INSERT INTO hub_status (version, started_at, delivery_configured, last_runs)
      VALUES ('live', ${new Date(T0)}, true, ${db.sql.json(live)}::jsonb)`;
    const holder = Bun.serve({ fetch: () => new Response(), hostname: '127.0.0.1', port: 0 });
    try {
      await using config = await configFile([
        'host = "127.0.0.1"',
        `port = ${String(holder.port)}`,
        '[database]',
        `url = "${db.url.href}"`,
      ]);
      const { code, stderr } = await invoke(['serve', ...configArgs(config)]);
      expect(stderr).toContain('Could not listen on');
      expect(code).toBe(1);
    } finally {
      await holder.stop(true);
    }
    expect(await statusRow(db.sql)).toEqual({
      delivery_configured: true,
      last_runs: live,
      started_at: new Date(T0),
      version: 'live',
    });
  });
});
