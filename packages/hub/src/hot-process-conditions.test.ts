import { beforeAll, expect, test } from 'bun:test';

import type { VitalsSample } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { readAttention } from '../../dashboard/src/server/attention.ts';
import { parseConditionLimits } from './condition-limits.ts';
import { evaluateConditions } from './evaluate-conditions.ts';
import { judgeHotProcessConditions } from './hot-process-conditions.ts';
import type { HotProcessFacts } from './hot-process-conditions.ts';
import { unpair } from './pairing.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { NOW, push, report, startHub, storeToken } from './testing/hub.ts';
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

const shortLimits = () =>
  parseConditionLimits({
    process: {
      noteMinutes: 0.5,
      noteWindowMinutes: 1,
      warningMinutes: 1,
      warningWindowMinutes: 2,
    },
  });

// The judge receives the readings selected by the transaction, without a Hub
// or database. Held levels and sample spans are facts of the prior occurrence.
const judge = (
  samples: VitalsSample[],
  overrides: Partial<HotProcessFacts> = {},
  now = samples.at(-1)?.t ?? NOW,
) =>
  judgeHotProcessConditions(
    {
      cursor: undefined,
      held: [],
      inserted: [],
      limits: shortLimits().process,
      rows: samples.map((row) => ({
        processes: row.processes ?? null,
        t: new Date(row.t),
        uptime_seconds: row.uptimeSeconds,
      })),
      ...overrides,
    },
    now,
  );

const warningHeld: HotProcessFacts['held'] = [
  { level: 'warning', sample_from: new Date(NOW + MINUTE), subject },
];

// An omitted process with a complete census can be quiet, unreadable, or gone.
const omitted = (
  samples: VitalsSample[],
  census: NonNullable<VitalsSample['processes']>['census'],
) =>
  samples.map((row) => ({
    ...row,
    processes: row.processes === undefined ? undefined : { ...row.processes, census, top: [] },
  }));

test('half-core equality stays quiet and measured hot time reaches note then warning with a process reason', () => {
  const limits = parseConditionLimits(undefined).process;
  const quiet = readings(NOW, 30, 0.5);
  expect(judge(quiet, { limits }).verdicts).toEqual([]);
  const almost = [...quiet, ...readings(NOW + 30 * MINUTE, 29.75)];
  expect(judge(almost, { limits }).verdicts).toEqual([]);
  const hot = [...almost, ...readings(NOW + 59.75 * MINUTE, 0.25)];
  expect(judge(hot, { limits }).verdicts).toEqual([
    {
      at: new Date(NOW + 60 * MINUTE),
      subject,
      verdict: {
        level: 'note',
        raise: `fseventsd (PID 42) above 0.5 core for 30 minutes in the 60 minutes ending ${new Date(NOW + 60 * MINUTE).toISOString()}.`,
      },
    },
  ]);
  expect(
    judge([...hot, ...readings(NOW + 60 * MINUTE, 90)], { limits }).verdicts.at(-1)?.verdict,
  ).toMatchObject({ level: 'warning' });
});

test('top-list omission preserves a warning until bounded CPU proves quiet or a complete census proves exit', () => {
  const hot = readings(NOW, 1);
  const held = { cursor: { through: new Date(NOW + MINUTE) }, held: warningHeld };
  const unknown = omitted(readings(NOW + 1.25 * MINUTE, 2), { kind: 'partial' });
  const uncertain = [...hot, ...unknown];
  expect(judge(uncertain, held)).toEqual({ coverage: { [subject]: false }, verdicts: [] });
  const busyOmission = omitted(readings(NOW + 3.5 * MINUTE, 1.25), {
    kind: 'complete',
    presentPids: [42],
    remainderMaxCores: 0.9,
    unknownPids: [],
  });
  expect(judge([...uncertain, ...busyOmission], held)).toEqual({
    coverage: { [subject]: false },
    verdicts: [],
  });
  const quiet = omitted(readings(NOW + 5 * MINUTE, 1.25), {
    kind: 'complete',
    presentPids: [42],
    remainderMaxCores: 0,
    unknownPids: [],
  });
  const recovered = [...uncertain, ...busyOmission, ...quiet];
  expect(judge(recovered, held).verdicts.at(-1)).toMatchObject({ subject, verdict: 'clear' });
  const reheated = [...recovered, ...readings(NOW + 6.5 * MINUTE, 0.5)];
  expect(judge(reheated, held).verdicts.at(-1)?.verdict).toMatchObject({ level: 'note' });
  const gone = omitted(readings(NOW + 7.25 * MINUTE, 0), {
    kind: 'complete',
    presentPids: [],
    remainderMaxCores: 0,
    unknownPids: [],
  });
  expect(judge([...reheated, ...gone], held).verdicts.at(-1)).toEqual({
    at: new Date(NOW + 7.25 * MINUTE),
    subject,
    verdict: 'clear',
  });
});

test('missing readings and unreadable PIDs preserve the held warning and mark coverage unknown', () => {
  const hot = readings(NOW, 1);
  const missing = readings(NOW + 5 * MINUTE, 1).map(({ processes: _processes, ...row }) => row);
  const held = { cursor: { through: new Date(NOW + MINUTE) }, held: warningHeld };
  expect(judge([...hot, ...missing], held)).toEqual({
    coverage: { [subject]: false },
    verdicts: [],
  });
  const unreadable = omitted(readings(NOW + 6.25 * MINUTE, 2), {
    kind: 'complete',
    presentPids: [42],
    remainderMaxCores: 0,
    unknownPids: [42],
  });
  expect(judge([...hot, ...missing, ...unreadable], held)).toEqual({
    coverage: { [subject]: false },
    verdicts: [],
  });
});

test('sleep supplies no busy time and a reboot starts a separate process lifetime', () => {
  const beforeReboot = [...readings(NOW, 0.25), ...readings(NOW + MINUTE, 0)];
  expect(judge(beforeReboot).verdicts).toEqual([]);
  const reboot = readings(NOW + 1.25 * MINUTE, 0.25).map((row, i) =>
    Object.assign(row, {
      processes: row.processes === undefined ? undefined : { ...row.processes, bootId: 'boot-2' },
      uptimeSeconds: 1 + i * 15,
    }),
  );
  expect(judge([...beforeReboot, ...reboot]).verdicts).toEqual([]);
});

test('recurring CPU bursts qualify despite a quiet newest reading', () => {
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
  expect(judge(bursts).verdicts.at(-1)?.verdict).toMatchObject({ level: 'note' });
});

test('old evidence cannot open a Condition and a stale exit cannot clear a held one after host-only readings', () => {
  const hot = readings(NOW, 1);
  const now = NOW + 3 * 60 * MINUTE;
  expect(judge(hot, {}, now).verdicts).toEqual([]);
  const gone = omitted(readings(NOW + 1.25 * MINUTE, 0), {
    kind: 'complete',
    presentPids: [],
    remainderMaxCores: 0,
    unknownPids: [],
  });
  const hostOnly = readings(now, 0).map(({ processes: _processes, ...row }) => row);
  expect(
    judge(
      [...hot, ...gone, ...hostOnly],
      { cursor: { through: new Date(NOW + MINUTE) }, held: warningHeld },
      now,
    ).verdicts,
  ).toEqual([]);
});

test('history-covered samples do not raise a duplicate and empty facts judge nothing', () => {
  const samples = readings(NOW, 1);
  expect(
    judge(samples, {
      inserted: [{ sample_from: new Date(NOW), sample_until: new Date(NOW + MINUTE), subject }],
    }).verdicts,
  ).toEqual([]);
  expect(judge([])).toEqual({ coverage: {}, verdicts: [] });
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

test('a clock rollback rejudges a cached old process episode when it becomes fresh', async () => {
  await using h = await startHub();
  h.clock.now = NOW + 3 * 60 * MINUTE;
  await send(h, readings(NOW, 1));
  expect(await evaluate(h, shortLimits())).toEqual([]);
  h.clock.now = NOW + 1.25 * MINUTE;
  expect((await evaluate(h, shortLimits()))[0]).toMatchObject({
    evidence: 'current',
    kind: 'hot_process',
    level: 'warning',
    subject,
  });
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

test('re-pairing rejudges unchanged process evidence after withdrawal', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 1));
  const [first] = await evaluate(h, shortLimits());
  expect(first?.level).toBe('warning');
  await unpair(h.db.sql, 'laptop-1');
  expect(await evaluate(h, shortLimits())).toEqual([]);
  await storeToken(h.db.sql, { pairedAt: NOW, system: 'laptop-1', token: 'laptop-token' });
  h.clock.now += 0.25 * MINUTE;
  const [next] = await evaluate(h, shortLimits());
  expect(next?.level).toBe('warning');
  expect(next?.firstDetected).not.toBe(first?.firstDetected);
});

test('missing Vitals leave the held process Condition and its evaluation cursor alone', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 1));
  const [before] = await evaluate(h, shortLimits());
  expect(before?.level).toBe('warning');
  await h.db.sql`DELETE FROM vitals_samples WHERE system = 'laptop-1'`;

  const [after] = await evaluate(h, shortLimits());

  expect(after).toMatchObject({ firstDetected: before?.firstDetected, level: 'warning', subject });
  const rows: { through: Date }[] = await h.db.sql`
    SELECT through FROM hot_process_evaluations WHERE system = 'laptop-1'
  `;
  expect(rows).toEqual([{ through: new Date(NOW + MINUTE) }]);
});

test('a partial census received in a Report leaves the held process warning unknown', async () => {
  await using h = await startHub();
  await send(h, readings(NOW, 1));
  expect((await evaluate(h, shortLimits()))[0]?.level).toBe('warning');
  await send(h, omitted(readings(NOW + 1.25 * MINUTE, 2), { kind: 'partial' }));

  expect((await evaluate(h, shortLimits()))[0]).toMatchObject({
    evidence: 'unknown',
    level: 'warning',
    subject,
  });
});
