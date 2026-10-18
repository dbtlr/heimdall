import { describe, expect, test } from 'bun:test';

import { blameHubClock, evaluateClockConditions } from './clock-conditions.ts';
import { parseConditionLimits } from './condition-limits.ts';
import { unpair } from './pairing.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import type { SystemConditionThresholds } from './system-conditions.ts';
import { NOW, push, report, startHub, storeToken } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const entry = (system: string, offsetMs: number, noteMs = 30 * SECOND) => ({
  noteMs,
  offsetMs,
  system,
});

const agreeingBy = (spread: number) =>
  blameHubClock([entry('a', 100 * SECOND), entry('b', 100 * SECOND + spread), entry('c', 0)]);

describe('blameHubClock', () => {
  test('blames the Hub when several Systems agree on a skew and one System reads true', () => {
    const blame = blameHubClock([
      entry('a', -182 * SECOND),
      entry('b', -183 * SECOND),
      entry('c', -181 * SECOND),
      entry('d', SECOND),
    ]);

    expect(blame).toEqual({ agreeing: ['a', 'b', 'c'], blamed: 'd', hubOffsetMs: 182 * SECOND });
  });

  test('takes the Hub offset as the negated median of the agreeing offsets', () => {
    const blame = blameHubClock([
      entry('a', 182 * SECOND),
      entry('b', 184 * SECOND),
      entry('c', 0),
    ]);

    expect(blame?.hubOffsetMs).toBe(-183 * SECOND);
  });

  test('fires when the agreeing offsets are exactly 5 seconds apart, and not when further', () => {
    expect(agreeingBy(5000)).toBeDefined();
    expect(agreeingBy(5001)).toBeUndefined();
  });

  test('does not fire with only one other System past its note limit', () => {
    expect(blameHubClock([entry('a', -182 * SECOND), entry('b', SECOND)])).toBeUndefined();
  });

  test('does not fire when no System reads true', () => {
    expect(
      blameHubClock([entry('a', 182 * SECOND), entry('b', 183 * SECOND), entry('c', 181 * SECOND)]),
    ).toBeUndefined();
  });

  test('does not fire when two Systems read true', () => {
    expect(
      blameHubClock([
        entry('a', 182 * SECOND),
        entry('b', 183 * SECOND),
        entry('c', SECOND),
        entry('d', -SECOND),
      ]),
    ).toBeUndefined();
  });

  test('does not fire when the skewed Systems disagree', () => {
    expect(
      blameHubClock([entry('a', 60 * SECOND), entry('b', 182 * SECOND), entry('c', SECOND)]),
    ).toBeUndefined();
  });

  test('judges each System against its own note limit', () => {
    const offsets = [entry('a', 40 * SECOND), entry('b', 41 * SECOND)];

    // c is 20 s off: past a 10 s limit, so not the one System reading true.
    expect(blameHubClock([...offsets, entry('c', 20 * SECOND, 10 * SECOND)])).toBeUndefined();
    expect(blameHubClock([...offsets, entry('c', 20 * SECOND, 60 * SECOND)])?.blamed).toBe('c');
  });
});

const tokenOf = (system: string) =>
  system.endsWith('-1') ? `${system.split('-')[0]}-token` : `${system}-token`;

// Pairs `systems` besides the two the Hub starts with.
const pair = async (h: Hub, ...systems: string[]) => {
  for (const system of systems) {
    // oxlint-disable-next-line no-await-in-loop -- one pairing at a time.
    await storeToken(h.db.sql, { pairedAt: NOW, system, token: tokenOf(system) });
  }
};

// Sends a Report that reaches the Hub at `time` from a System whose clock is
// `offsetMs` ahead of the Hub's.
const send = async (h: Hub, time: number, offsetMs: number, system = 'laptop-1') => {
  h.clock.now = time;
  const body = { ...report(system, [time]), sentAt: time + offsetMs };
  expect((await push(h.hub, body, { token: tokenOf(system) })).status).toBe(200);
};

const evaluate = (
  h: Hub,
  time: number,
  thresholds: SystemConditionThresholds = SYSTEM_CONDITION_THRESHOLDS,
) => {
  h.clock.now = time;
  return evaluateClockConditions(h.db.sql, () => h.clock.now, thresholds);
};

const open = (h: Hub): Promise<{ level: string; reason: string; system: string }[]> =>
  h.db.sql`
    SELECT system, level, latest_reason AS reason FROM conditions
    WHERE kind = 'clock_skew' AND subject = '' AND cleared_at IS NULL ORDER BY system
  `;

// The level of each transition of a System's clock skew Condition, in order.
const transitions = async (h: Hub, system = 'laptop-1') => {
  const rows: { action: string; level: string }[] = await h.db.sql`
    SELECT t.action, t.level FROM condition_transitions t
    JOIN conditions c ON c.id = t.condition
    WHERE c.system = ${system} AND c.kind = 'clock_skew' ORDER BY t.id
  `;
  return rows.map((row) => `${row.action}:${row.level}`);
};

const T = NOW + MINUTE;

describe('clock skew', () => {
  test.each([
    [42 * SECOND, 'note', "Its clock is 42 s ahead of the Hub's."],
    [-30 * SECOND, 'note', "Its clock is 30 s behind the Hub's."],
    [130 * SECOND, 'warning', "Its clock is 2 min 10 s ahead of the Hub's."],
    [-120 * SECOND, 'warning', "Its clock is 2 min behind the Hub's."],
    [300 * SECOND, 'alert', "Its clock is 5 min ahead of the Hub's."],
    [-3720 * SECOND, 'alert', "Its clock is 1 h 2 min behind the Hub's."],
  ])('an offset of %d ms is judged %s', async (offset, level, reason) => {
    await using h = await startHub();
    await send(h, T, offset);

    await evaluate(h, T);

    expect(await open(h)).toEqual([{ level, reason, system: 'laptop-1' }]);
  });

  test('an offset under the note limit raises nothing', async () => {
    await using h = await startHub();
    await send(h, T, 29 * SECOND);

    await evaluate(h, T);

    expect(await open(h)).toEqual([]);
  });

  test('escalates at once, and steps down or clears only a hysteresis below each limit', async () => {
    await using h = await startHub();
    let time = T;
    const settle = async (offsetMs: number) => {
      await send(h, time, offsetMs);
      await evaluate(h, time);
      time += MINUTE;
      return (await open(h)).map((row) => row.level);
    };

    expect(await settle(310 * SECOND)).toEqual(['alert']);
    // 295 s is the alert limit less the 5 s hysteresis.
    expect(await settle(295 * SECOND)).toEqual(['alert']);
    expect(await settle(294 * SECOND)).toEqual(['warning']);
    expect(await settle(115 * SECOND)).toEqual(['warning']);
    expect(await settle(114 * SECOND)).toEqual(['note']);
    expect(await settle(25 * SECOND)).toEqual(['note']);
    expect(await settle(-24 * SECOND)).toEqual([]);
    expect(await transitions(h)).toEqual([
      'raised:alert',
      'level_changed:warning',
      'level_changed:note',
      'cleared:note',
    ]);
    // Straight back up skips the intermediate levels.
    expect(await settle(-400 * SECOND)).toEqual(['alert']);
  });

  test('holds an open Condition while its offset is older than 10 minutes', async () => {
    await using h = await startHub();
    await send(h, T, 60 * SECOND);
    await evaluate(h, T);
    await send(h, T + MINUTE, 0);

    await evaluate(h, T + MINUTE + 10 * MINUTE + SECOND);
    expect((await open(h)).map((row) => row.level)).toEqual(['note']);

    await evaluate(h, T + MINUTE + 10 * MINUTE);
    expect(await open(h)).toEqual([]);
  });

  test('raises nothing from an offset older than 10 minutes', async () => {
    await using h = await startHub();
    await send(h, T, 400 * SECOND);

    await evaluate(h, T + 10 * MINUTE + SECOND);

    expect(await open(h)).toEqual([]);
  });

  test('judges a System by its own limits, overriding the fleet', async () => {
    await using h = await startHub();
    await send(h, T, 100 * SECOND, 'laptop-1');
    await send(h, T, 100 * SECOND, 'server-1');
    const thresholds = {
      ...SYSTEM_CONDITION_THRESHOLDS,
      ...parseConditionLimits({ systems: { 'laptop-1': { clock: { note: 20, warning: 90 } } } }),
    };

    await evaluate(h, T, thresholds);

    expect(await open(h)).toEqual([
      expect.objectContaining({ level: 'warning', system: 'laptop-1' }),
      expect.objectContaining({ level: 'note', system: 'server-1' }),
    ]);
  });

  test('clears the Condition of a System that is no longer paired', async () => {
    await using h = await startHub();
    await send(h, T, 60 * SECOND);
    await evaluate(h, T);
    expect(await open(h)).toHaveLength(1);

    await unpair(h.db.sql, 'laptop-1');
    await evaluate(h, T + MINUTE);

    expect(await open(h)).toEqual([]);
    expect(await transitions(h)).toEqual(['raised:note', 'cleared:note']);
  });

  describe('when the Hub clock is wrong', () => {
    test('is raised on the one System that reads true, and on none that agree', async () => {
      await using h = await startHub();
      await pair(h, 'a-box', 'b-box');
      await send(h, T, SECOND, 'laptop-1');
      await send(h, T, -182 * SECOND, 'server-1');
      await send(h, T, -183 * SECOND, 'a-box');
      await send(h, T, -181 * SECOND, 'b-box');

      await evaluate(h, T);

      expect(await open(h)).toEqual([
        {
          level: 'warning',
          reason: "The Hub's clock is 3 min 2 s ahead of 3 other Systems.",
          system: 'laptop-1',
        },
      ]);
    });

    test('clears a Condition an agreeing System held before the rule applied', async () => {
      await using h = await startHub();
      await pair(h, 'a-box', 'b-box');
      await send(h, T, SECOND, 'laptop-1');
      await send(h, T, -182 * SECOND, 'server-1');
      await send(h, T, SECOND, 'a-box');
      await send(h, T, SECOND, 'b-box');
      await evaluate(h, T);
      expect(await open(h)).toEqual([expect.objectContaining({ system: 'server-1' })]);

      await send(h, T + MINUTE, -182 * SECOND, 'a-box');
      await send(h, T + MINUTE, -182 * SECOND, 'b-box');
      await send(h, T + MINUTE, SECOND, 'laptop-1');
      await send(h, T + MINUTE, -182 * SECOND, 'server-1');
      await evaluate(h, T + MINUTE);

      expect(await open(h)).toEqual([expect.objectContaining({ system: 'laptop-1' })]);
    });

    test('is levelled by the blamed System limits, with their hysteresis', async () => {
      await using h = await startHub();
      await pair(h, 'a-box', 'b-box');
      const settle = async (time: number, hubAhead: number) => {
        for (const system of ['server-1', 'a-box', 'b-box']) {
          // oxlint-disable-next-line no-await-in-loop -- one Report at a time.
          await send(h, time, -hubAhead, system);
        }
        await send(h, time, 0, 'laptop-1');
        await evaluate(h, time);
        return (await open(h)).map((row) => `${row.system}:${row.level}`);
      };

      expect(await settle(T, 310 * SECOND)).toEqual(['laptop-1:alert']);
      expect(await settle(T + MINUTE, 296 * SECOND)).toEqual(['laptop-1:alert']);
      expect(await settle(T + 2 * MINUTE, 200 * SECOND)).toEqual(['laptop-1:warning']);
    });

    test('judges each System alone when only one other System is skewed', async () => {
      await using h = await startHub();
      await send(h, T, SECOND, 'laptop-1');
      await send(h, T, -182 * SECOND, 'server-1');

      await evaluate(h, T);

      expect(await open(h)).toEqual([
        {
          level: 'warning',
          reason: "Its clock is 3 min 2 s behind the Hub's.",
          system: 'server-1',
        },
      ]);
    });
  });
});
