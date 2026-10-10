import { describe, expect, test } from 'bun:test';

import { filesRecordDigest } from '@heimdall/schema';

import { evaluateConditions, runInTurn } from './evaluate-conditions.ts';
import { listSystems } from './store.ts';
import type { ConditionKind } from './store.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { NOW, push, report, sampleTimes, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

const MINUTE = 60_000;

const CONFIG = { files: [{ path: '/etc/app.conf', sha256: 'a'.repeat(64) }], name: 'app-config' };

// laptop-1 reported a failed job run, a changed file, and a Service that had
// been stopped through 5 awake minutes up to NOW and then went quiet, so by
// NOW + 11 minutes it is failing a job, drifting, has a Service down, and is
// stale.
const failingAndQuiet = async (h: Hub) => {
  const response = await push(
    h.hub,
    {
      ...report('laptop-1', sampleTimes(NOW - 5 * MINUTE, NOW + 15_000)),
      checks: {
        fileRecords: [{ digest: await filesRecordDigest(CONFIG), record: 'app-config' }],
        files: [{ path: '/etc/app.conf', record: 'app-config', since: NOW, state: 'drifted' }],
        services: [
          {
            check: 'supervisor',
            detail: 'ActiveState=failed',
            service: 'webapp',
            since: NOW - 5 * MINUTE,
            state: 'stopped',
          },
        ],
      },
      records: {
        records: [
          {
            kind: 'job',
            name: 'backup',
            record: {
              label: 'com.example.backup',
              name: 'backup',
              schedule: [{ hour: 3, minute: 30 }],
              scheduler: 'launchd',
            },
          },
          { kind: 'files', name: 'app-config', record: CONFIG },
          {
            kind: 'service',
            name: 'webapp',
            record: { name: 'webapp', supervisor: 'systemd', unit: 'webapp.service' },
          },
        ],
        unreadable: [],
      },
      runs: {
        jobs: [
          {
            job: 'backup',
            latestRun: {
              exitStatus: 1,
              finished: '2026-10-06T11:59:00Z',
              started: '2026-10-06T11:58:00Z',
            },
            latestSuccess: null,
          },
        ],
        unreadable: [],
      },
      timeZone: 'America/New_York',
    },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);
};

const openKinds = async (h: Hub) =>
  ((await listSystems(h.db.sql))[0]?.conditions ?? []).map((c) => c.kind).toSorted();

const judge = (h: Hub) => {
  h.clock.now = NOW + 11 * MINUTE;
  return evaluateConditions(h.db.sql, () => h.clock.now, SYSTEM_CONDITION_THRESHOLDS);
};

describe('judging every Condition', () => {
  test('runs the job, System, Drift, and Service evaluators', async () => {
    await using h = await startHub();
    await failingAndQuiet(h);

    await judge(h);

    expect(await openKinds(h)).toEqual(['drift', 'job_failing', 'service_down', 'system_stale']);
  });

  test('judges Service down after Drift', async () => {
    await using h = await startHub();
    await failingAndQuiet(h);

    await judge(h);

    const raised: { kind: string }[] = await h.db.sql`
      SELECT kind FROM conditions WHERE kind IN ('drift', 'service_down') ORDER BY id
    `;
    expect(raised.map((c) => c.kind)).toEqual(['drift', 'service_down']);
  });

  test.each<[ConditionKind, ConditionKind[]]>([
    ['job_failing', ['drift', 'service_down', 'system_stale']],
    ['system_stale', ['drift', 'job_failing', 'service_down']],
    ['drift', ['job_failing', 'service_down', 'system_stale']],
    ['service_down', ['drift', 'job_failing', 'system_stale']],
  ])(
    'a database refusing %s does not stop the others, and the failure is reported',
    async (refused, others) => {
      await using h = await startHub();
      await failingAndQuiet(h);
      await h.db.sql.unsafe(`
      CREATE FUNCTION refuse_kind() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse_kind BEFORE INSERT ON conditions
        FOR EACH ROW WHEN (NEW.kind = '${refused}') EXECUTE FUNCTION refuse_kind();
    `);

      const failure = await judge(h).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ message: expect.stringContaining('refused') });
      expect(await openKinds(h)).toEqual(others);
    },
  );
});

describe('running evaluators in turn', () => {
  test('runs each after the one before it finishes', async () => {
    const order: string[] = [];
    const slow = async () => {
      order.push('slow starts');
      await Bun.sleep(20);
      order.push('slow ends');
    };

    await runInTurn([slow, () => Promise.resolve(void order.push('next'))]);

    expect(order).toEqual(['slow starts', 'slow ends', 'next']);
  });

  test('reports every failure after running them all', async () => {
    const ran: string[] = [];
    const failing = (name: string) => () => {
      ran.push(name);
      return Promise.reject(new Error(`${name} failed`));
    };

    const failure = await runInTurn([
      failing('first'),
      () => Promise.resolve(void ran.push('second')),
      failing('third'),
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(ran).toEqual(['first', 'second', 'third']);
    expect(failure).toMatchObject({ message: 'first failed; third failed' });
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  test('succeeds when none fails', async () => {
    expect(await runInTurn([() => Promise.resolve(), () => Promise.resolve()])).toBeUndefined();
  });

  test('a single failure is reported', async () => {
    const failure = await runInTurn([() => Promise.reject(new Error('only'))]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ message: 'only' });
  });
});
