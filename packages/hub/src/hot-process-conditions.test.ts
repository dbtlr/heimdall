import { beforeAll, expect, test } from 'bun:test';

import type { VitalsSample } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { readAttention } from '../../dashboard/src/server/attention.ts';
import { parseConditionLimits } from './condition-limits.ts';
import { evaluateConditions } from './evaluate-conditions.ts';
import { unpair } from './pairing.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { startTestServer } from './testing/postgres.ts';

beforeAll(startTestServer, 60_000);

const MINUTE = 60_000;
const STEP = 15_000;
const subject = JSON.stringify(['boot-1', 42, '100', 'fseventsd']);

const readings = (from: number, minutes: number, cores = 0.86): VitalsSample[] =>
  Array.from({ length: minutes * 4 + 1 }, (_, i) => ({
    ...sample(from + i * STEP),
    processes: {
      bootId: 'boot-1',
      census: {
        kind: 'complete',
        presentPids: [42],
        remainderMaxCores: 0,
        unknownPids: [],
      },
      intervalMs: STEP,
      top: [{ cpuCores: cores, name: 'fseventsd', pid: 42, rssBytes: 4096, start: '100' }],
    },
    uptimeSeconds: 1000 + (from - NOW + i * STEP) / 1000,
  }));

const send = async (h: Hub, samples: VitalsSample[]) => {
  const last = samples.at(-1);
  if (last === undefined) {
    throw new Error('Expected process observations.');
  }
  h.clock.now = Math.max(h.clock.now, last.t);
  expect(
    (
      await push(
        h.hub,
        { ...report('laptop-1', []), samples, sentAt: h.clock.now },
        { token: 'laptop-token' },
      )
    ).status,
  ).toBe(200);
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
  ).filter((item) => item.kind === 'hot_process');
};

test('half-core equality stays quiet; measured hot time names the process and escalates one occurrence', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 30, 0.5));
  expect(await evaluate(h)).toEqual([]);
  await send(h, readings(NOW + 30 * MINUTE, 29.75));
  expect(await evaluate(h)).toEqual([]);
  await send(h, readings(NOW + 59.75 * MINUTE, 0.25));
  const [note] = await evaluate(h);
  expect(note).toMatchObject({ evidence: 'current', kind: 'hot_process', level: 'note', subject });
  expect(note?.reason).toContain('fseventsd');
  expect(note?.reason).toContain('PID 42');
  expect(note?.reason).toContain('30 minutes');
  await send(h, readings(NOW + 60 * MINUTE, 90));
  const [warning] = await evaluate(h);
  expect(warning?.level).toBe('warning');
  expect(warning?.firstDetected).toBe(note?.firstDetected);
});

const shortLimits = () =>
  parseConditionLimits({
    process: {
      noteMinutes: 0.5,
      noteWindowMinutes: 1,
      warningMinutes: 1,
      warningWindowMinutes: 2,
    },
  });

test('PID reuse starts another lifetime and subsequent evaluations keep its own occurrence', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 0.5));
  const [first] = await evaluate(h, shortLimits());
  expect(first?.level).toBe('note');
  const replacement = readings(NOW + 0.75 * MINUTE, 0.75).map((row, index) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              intervalMs: index === 0 ? 0 : STEP,
              top: row.processes.top.map((entry) => ({ ...entry, start: '200' })),
            },
    }),
  );
  await send(h, replacement);
  const [second] = await evaluate(h, shortLimits());
  expect(second?.subject).toBe(JSON.stringify(['boot-1', 42, '200', 'fseventsd']));
  expect(second?.level).toBe('note');
  const latest = replacement.at(-1);
  if (latest === undefined) {
    throw new Error('Expected the replacement process.');
  }
  await send(h, [{ ...latest, t: NOW + 1.75 * MINUTE, uptimeSeconds: 1105 }]);
  expect((await evaluate(h, shortLimits()))[0]?.subject).toBe(second?.subject);
});

test('top-list omission is unknown until bounded CPU proves quiet, and confirmed exit clears immediately', async () => {
  await using h = await startHub();
  const limits = shortLimits();
  await send(h, readings(NOW, 1));
  const [warning] = await evaluate(h, limits);
  expect(warning?.level).toBe('warning');

  const unknown = readings(NOW + 1.25 * MINUTE, 2).map((row) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              census: { kind: 'partial' as const },
              top: [],
            },
    }),
  );
  await send(h, unknown);
  expect(await evaluate(h, limits)).toEqual([
    expect.objectContaining({ evidence: 'unknown', level: 'warning' }),
  ]);

  const omittedBusy = readings(NOW + 3.5 * MINUTE, 1.25).map((row) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              census: {
                kind: 'complete' as const,
                presentPids: [42],
                remainderMaxCores: 0.9,
                unknownPids: [],
              },
              top: [],
            },
    }),
  );
  await send(h, omittedBusy);
  expect((await evaluate(h, limits))[0]).toMatchObject({ evidence: 'unknown', level: 'warning' });

  const quiet = readings(NOW + 5 * MINUTE, 1.25).map((row) =>
    Object.assign(row, {
      processes: row.processes === undefined ? undefined : { ...row.processes, top: [] },
    }),
  );
  await send(h, quiet);
  expect(await evaluate(h, limits)).toEqual([]);

  await send(h, readings(NOW + 6.5 * MINUTE, 0.5));
  expect((await evaluate(h, limits))[0]?.level).toBe('note');
  const gone = readings(NOW + 7.25 * MINUTE, 0).map((row) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              census: {
                kind: 'complete' as const,
                presentPids: [],
                remainderMaxCores: 0,
                unknownPids: [],
              },
              top: [],
            },
    }),
  );
  await send(h, gone);
  expect(await evaluate(h, limits)).toEqual([]);
});

test('missing process readings and unreadable PIDs preserve the stored level', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 1));
  expect((await evaluate(h, shortLimits()))[0]?.level).toBe('warning');
  const missing = readings(NOW + 5 * MINUTE, 1).map(({ processes: _processes, ...row }) => row);
  await send(h, missing);
  expect((await evaluate(h, shortLimits()))[0]).toMatchObject({
    evidence: 'unknown',
    level: 'warning',
  });
  const unreadable = readings(NOW + 6.25 * MINUTE, 2).map((row) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              census: {
                kind: 'complete' as const,
                presentPids: [42],
                remainderMaxCores: 0,
                unknownPids: [42],
              },
              top: [],
            },
    }),
  );
  await send(h, unreadable);
  expect((await evaluate(h, shortLimits()))[0]).toMatchObject({
    evidence: 'unknown',
    level: 'warning',
  });
});

test('fresh host-only Vitals cannot turn an old exit census into recovery', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 1));
  expect((await evaluate(h, shortLimits()))[0]?.level).toBe('warning');
  h.clock.now = NOW + 3 * 60 * MINUTE;
  const gone = readings(NOW + 1.25 * MINUTE, 0).map((row) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              census: {
                kind: 'complete' as const,
                presentPids: [],
                remainderMaxCores: 0,
                unknownPids: [],
              },
              top: [],
            },
    }),
  );
  await send(h, gone);
  expect((await evaluate(h, shortLimits()))[0]).toMatchObject({
    evidence: 'old',
    level: 'warning',
  });
  const hostOnly = readings(h.clock.now, 0).map(({ processes: _processes, ...row }) => row);
  await send(h, hostOnly);
  expect((await evaluate(h, shortLimits()))[0]).toMatchObject({
    evidence: 'unknown',
    level: 'warning',
  });
  await send(
    h,
    gone.map((row) =>
      Object.assign(row, {
        t: h.clock.now + STEP,
        uptimeSeconds: 1000 + (h.clock.now + STEP - NOW) / 1000,
      }),
    ),
  );
  expect(await evaluate(h, shortLimits())).toEqual([]);
});

test('sleep and reboot cannot supply busy time or combine different process lifetimes', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 0.25));
  await send(h, readings(NOW + MINUTE, 0));
  expect(await evaluate(h, shortLimits())).toEqual([]);
  const reboot = readings(NOW + 1.25 * MINUTE, 0.25).map((row, i) =>
    Object.assign(row, {
      processes: row.processes === undefined ? undefined : { ...row.processes, bootId: 'boot-2' },
      uptimeSeconds: 1 + i * 15,
    }),
  );
  await send(h, reboot);
  expect(await evaluate(h, shortLimits())).toEqual([]);
});

test('recurring individual CPU bursts qualify despite a quiet newest reading', async () => {
  await using h = await startHub();
  const bursts = readings(NOW, 1).map((row, i) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              top: row.processes.top.map((entry) => ({
                ...entry,
                cpuCores: i === 1 || i === 3 ? 0.86 : 0.1,
              })),
            },
    }),
  );
  await send(h, bursts);
  expect((await evaluate(h, shortLimits()))[0]?.level).toBe('note');
});

test('older backlogs record completed episodes once, including exit, without opening a current Condition', async () => {
  await using h = await startHub();
  const hot = readings(NOW, 1);
  const gone = readings(NOW + 1.25 * MINUTE, 0).map((row) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              census: {
                kind: 'complete' as const,
                presentPids: [],
                remainderMaxCores: 0,
                unknownPids: [],
              },
              top: [],
            },
    }),
  );
  h.clock.now = NOW + 3 * 60 * MINUTE;
  await send(h, [...hot, ...gone]);
  expect(await evaluate(h, shortLimits())).toEqual([]);
  const history: { action: string; level: string }[] = await h.db.sql`
    SELECT t.action, t.level FROM condition_transitions t JOIN conditions c ON c.id = t.condition
    WHERE c.kind = 'hot_process' ORDER BY t.id
  `;
  expect(history).toEqual([
    { action: 'raised', level: 'note' },
    { action: 'level_changed', level: 'warning' },
    { action: 'cleared', level: 'warning' },
  ]);
  await send(h, [...hot, ...gone]);
  await evaluate(h, shortLimits());
  const count: { n: number }[] = await h.db
    .sql`SELECT count(*)::int AS n FROM conditions WHERE kind = 'hot_process'`;
  expect(count[0]?.n).toBe(1);
});

test('an unfinished old episode survives separate batches until fresh quiet evidence records recovery', async () => {
  await using h = await startHub();
  h.clock.now = NOW + 3 * 60 * MINUTE;
  await send(h, readings(NOW, 1));
  expect(await evaluate(h, shortLimits())).toEqual([]);
  await send(h, readings(NOW + MINUTE, 1, 0.1));
  expect(await evaluate(h, shortLimits())).toEqual([]);
  await send(h, readings(h.clock.now, 1.25, 0.1));
  expect(await evaluate(h, shortLimits())).toEqual([]);
  const rows: { level: string; cleared_at: Date | null }[] = await h.db.sql`
    SELECT level, cleared_at FROM conditions WHERE kind = 'hot_process'
  `;
  expect(rows).toEqual([{ cleared_at: new Date(h.clock.now), level: 'warning' }]);
  await evaluate(h, shortLimits());
  const count: { n: number }[] = await h.db
    .sql`SELECT count(*)::int AS n FROM conditions WHERE kind = 'hot_process'`;
  expect(count[0]?.n).toBe(1);
});

test('late historical episodes preserve a later live occurrence of the same process', async () => {
  await using h = await startHub();
  const live = readings(NOW + 10 * MINUTE, 0.5);
  await send(h, live);
  const [before] = await evaluate(h, shortLimits());
  expect(before?.level).toBe('note');
  const history = readings(NOW, 2, 0.86).map((row, i) =>
    Object.assign(row, {
      processes:
        row.processes === undefined
          ? undefined
          : {
              ...row.processes,
              top: row.processes.top.map((entry) =>
                Object.assign(entry, { cpuCores: i <= 2 ? 0.86 : 0.1 }),
              ),
            },
    }),
  );
  await send(h, history);
  const [after] = await evaluate(h, shortLimits());
  expect(after?.firstDetected).toBe(before?.firstDetected);
  expect(after?.level).toBe('note');
  const count: { n: number }[] = await h.db
    .sql`SELECT count(*)::int AS n FROM conditions WHERE kind = 'hot_process'`;
  expect(count[0]?.n).toBe(2);
  await evaluate(h, shortLimits());
  const again: { n: number }[] = await h.db
    .sql`SELECT count(*)::int AS n FROM conditions WHERE kind = 'hot_process'`;
  expect(again[0]?.n).toBe(2);
});

test('per-System core limits change the next judgment and unpairing withdraws process Conditions', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 0.5));
  const raisedLimit = parseConditionLimits({
    process: shortLimits().process,
    systems: { 'laptop-1': { process: { cores: 1 } } },
  });
  expect(await evaluate(h, raisedLimit)).toEqual([]);
  expect((await evaluate(h, shortLimits()))[0]?.level).toBe('note');
  await unpair(h.db.sql, 'laptop-1');
  expect(await evaluate(h, shortLimits())).toEqual([]);
});
