import { describe, expect, test } from 'bun:test';

import type { ConditionLevel } from '@heimdall/schema';

import { blameHubClock, evaluateClockConditions, judgeClockSkew } from './clock-conditions.ts';
import type { ClockSkewFacts, ClockSkewVerdict } from './clock-conditions.ts';
import { CLOCK_LIMITS, parseConditionLimits } from './condition-limits.ts';
import { unpair } from './pairing.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import type { SystemConditionThresholds } from './system-conditions.ts';
import { NOW, push, report, startHub, storeToken } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const entry = (system: string, offsetMs: number) => ({ offsetMs, system });

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

  test('fires while the Hub is only 10 seconds off', () => {
    const blame = blameHubClock([
      entry('a', -10 * SECOND),
      entry('b', -10 * SECOND),
      entry('c', 200),
    ]);

    expect(blame).toEqual({ agreeing: ['a', 'b'], blamed: 'c', hubOffsetMs: 10 * SECOND });
  });

  // Classifying by a note limit flapped while the Hub's clock drifted through
  // it: Systems sat either side of the limit with millisecond jitter.
  test('keeps blaming the Hub while the others jitter around a note limit', () => {
    for (const jitter of [29_990, 30_010]) {
      const blame = blameHubClock([
        entry('a', -jitter),
        entry('b', -(60_000 - jitter)),
        entry('c', 200),
      ]);

      expect(blame?.blamed).toBe('c');
    }
  });

  test('reads a System as true up to exactly 5 seconds from the Hub, and off beyond', () => {
    const others = [entry('a', -40 * SECOND), entry('b', -40 * SECOND)];

    expect(blameHubClock([...others, entry('c', 5000)])?.blamed).toBe('c');
    expect(blameHubClock([...others, entry('c', -5000)])?.blamed).toBe('c');
    expect(blameHubClock([...others, entry('c', 5001)])).toBeUndefined();
  });

  test('fires when the off Systems are exactly 5 seconds apart, and not when further', () => {
    expect(agreeingBy(5000)).toBeDefined();
    expect(agreeingBy(5001)).toBeUndefined();
  });

  test('does not fire with only one other System off', () => {
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

  test('does not fire when the off Systems disagree', () => {
    expect(
      blameHubClock([entry('a', 60 * SECOND), entry('b', 182 * SECOND), entry('c', SECOND)]),
    ).toBeUndefined();
  });
});

// Judges `system` among Systems at the given offsets (in milliseconds), blaming
// the Hub's clock as the evaluation round does.
const judge = (offsets: Record<string, number>, changes: Partial<ClockSkewFacts> = {}) => {
  const map = new Map(Object.entries(offsets));
  return judgeClockSkew({
    blame: blameHubClock([...map].map(([system, offsetMs]) => entry(system, offsetMs))),
    held: {},
    limits: CLOCK_LIMITS,
    offsets: map,
    paired: true,
    system: 'laptop-1',
    ...changes,
  });
};

const levelOf = (verdict: ClockSkewVerdict) =>
  typeof verdict === 'string' ? verdict : verdict.level;

// The verdicts for laptop-1 when it reads `laptop` and the other three Systems
// read `rest`.
const among = (laptop: number, rest: number) =>
  judge({ 'a-box': rest, 'b-box': rest, 'laptop-1': laptop, 'server-1': rest });

// laptop-1's Hub identity verdict when the other Systems read the Hub
// `hubAhead` seconds ahead, with a little spread between them, as real clocks
// have.
const hubLevel = (hubAhead: number, held?: ConditionLevel) =>
  levelOf(
    judge(
      {
        'a-box': -(hubAhead * SECOND),
        'b-box': -(hubAhead * SECOND + 500),
        'laptop-1': 0,
        'server-1': -(hubAhead * SECOND - 500),
      },
      { held: { hub: held } },
    ).hub,
  );

const ownLevel = (seconds: number, held?: ConditionLevel) =>
  levelOf(judge({ 'laptop-1': seconds * SECOND }, { held: { own: held } }).own);

describe('judgeClockSkew', () => {
  test.each<[number, ConditionLevel, string]>([
    [-30 * SECOND, 'note', "Its clock is 30 s behind the Hub's."],
    [130 * SECOND, 'warning', "Its clock is 2 min 10 s ahead of the Hub's."],
    [-120 * SECOND, 'warning', "Its clock is 2 min behind the Hub's."],
    [300 * SECOND, 'alert', "Its clock is 5 min ahead of the Hub's."],
    [-3720 * SECOND, 'alert', "Its clock is 1 h 2 min behind the Hub's."],
  ])('an offset of %d ms is judged %s on its own clock', (offset, level, reason) => {
    expect(judge({ 'laptop-1': offset })).toEqual({ hub: 'clear', own: { level, reason } });
  });

  test('clears an offset under the note limit', () => {
    expect(judge({ 'laptop-1': 29 * SECOND }).own).toBe('clear');
  });

  test('escalates at once, and steps down or clears only a hysteresis below each limit', () => {
    expect(ownLevel(310)).toBe('alert');
    // 295 s is the alert limit less the 5 s hysteresis.
    expect(ownLevel(295, 'alert')).toBe('alert');
    expect(ownLevel(294, 'alert')).toBe('warning');
    expect(ownLevel(115, 'warning')).toBe('warning');
    expect(ownLevel(114, 'warning')).toBe('note');
    expect(ownLevel(25, 'note')).toBe('note');
    expect(ownLevel(-24, 'note')).toBe('clear');
    // Straight back up skips the intermediate levels.
    expect(ownLevel(-400, 'note')).toBe('alert');
  });

  test('judges a System by the limits it is given', () => {
    const limits = { ...CLOCK_LIMITS, note: 20, warning: 90 };

    expect(judge({ 'laptop-1': 100 * SECOND }, { limits }).own).toMatchObject({ level: 'warning' });
  });

  test('holds both identities for a System with no fresh offset', () => {
    expect(judge({ 'server-1': 60 * SECOND })).toEqual({ hub: 'hold', own: 'hold' });
  });

  test('clears both identities of a System that is no longer paired', () => {
    expect(judge({ 'laptop-1': 400 * SECOND }, { paired: false })).toEqual({
      hub: 'clear',
      own: 'clear',
    });
  });

  describe('when the Hub clock is wrong', () => {
    const others = { 'a-box': -183 * SECOND, 'b-box': -181 * SECOND, 'server-1': -182 * SECOND };

    test('is raised on the one System that reads true, holding the Hub clock and not its own', () => {
      expect(judge({ 'laptop-1': SECOND, ...others })).toEqual({
        hub: {
          level: 'warning',
          reason: "The Hub's clock is 3 min 2 s ahead of 3 other Systems.",
        },
        own: 'clear',
      });
    });

    test('is raised on none of the Systems that agree, and clears what they held', () => {
      const facts = { 'laptop-1': SECOND, ...others };

      expect(judge(facts, { held: { own: 'warning' }, system: 'server-1' })).toEqual({
        hub: 'clear',
        own: 'clear',
      });
    });

    test('moves a System between its own clock and the Hub clock as the blame comes and goes', () => {
      expect(among(40 * SECOND, 0)).toMatchObject({ hub: 'clear', own: { level: 'note' } });
      expect(among(2 * SECOND, -182 * SECOND)).toMatchObject({
        hub: { level: 'warning' },
        own: 'clear',
      });
      expect(among(2 * SECOND, 0)).toEqual({ hub: 'clear', own: 'clear' });
    });

    test('raises nothing and clears the others while the Hub is under every note limit', () => {
      const small = { 'a-box': -20 * SECOND, 'b-box': -20 * SECOND, 'server-1': -20 * SECOND };

      expect(judge({ 'laptop-1': 0, ...small })).toEqual({ hub: 'clear', own: 'clear' });
      expect(judge({ 'laptop-1': 0, ...small }, { system: 'a-box' })).toEqual({
        hub: 'clear',
        own: 'clear',
      });
    });

    test('blames nobody while the Systems that are off disagree, each judged on its own clock', () => {
      const spread = { 'a-box': -50 * SECOND, 'b-box': -60 * SECOND, 'server-1': -40 * SECOND };

      expect(judge({ 'laptop-1': 0, ...spread })).toEqual({ hub: 'clear', own: 'clear' });
      expect(judge({ 'laptop-1': 0, ...spread }, { system: 'a-box' })).toMatchObject({
        own: { level: 'note' },
      });
    });

    test('raises a note on the blamed System as the Hub drifts through 30 seconds, and keeps it through the hysteresis band', () => {
      expect(hubLevel(29)).toBe('clear');
      expect(hubLevel(31)).toBe('note');
      expect(hubLevel(33, 'note')).toBe('note');
      expect(hubLevel(27, 'note')).toBe('note');
      expect(hubLevel(24, 'note')).toBe('clear');
    });
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

// Subject '' says the System's own clock disagrees with the Hub's; 'hub' says
// the Hub's clock is wrong.
const open = (
  h: Hub,
): Promise<{ level: string; reason: string; subject: string; system: string }[]> =>
  h.db.sql`
    SELECT system, level, latest_reason AS reason, subject FROM conditions
    WHERE kind = 'clock_skew' AND cleared_at IS NULL ORDER BY system, subject
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
  test('raises an offset with its level and reason, and keeps the level it holds through the hysteresis band', async () => {
    await using h = await startHub();

    await send(h, T, 310 * SECOND);
    await evaluate(h, T);
    expect(await open(h)).toEqual([
      {
        level: 'alert',
        reason: "Its clock is 5 min 10 s ahead of the Hub's.",
        subject: '',
        system: 'laptop-1',
      },
    ]);

    await send(h, T + MINUTE, 295 * SECOND);
    await evaluate(h, T + MINUTE);
    expect((await open(h)).map((row) => row.level)).toEqual(['alert']);

    await send(h, T + 2 * MINUTE, 294 * SECOND);
    await evaluate(h, T + 2 * MINUTE);
    expect(await transitions(h)).toEqual(['raised:alert', 'level_changed:warning']);
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
          subject: 'hub',
          system: 'laptop-1',
        },
      ]);
    });

    test('raises a note on the blamed System as the Hub drifts through 30 seconds, and keeps it through the hysteresis band', async () => {
      await using h = await startHub();
      await pair(h, 'a-box', 'b-box');
      let time = T;
      const drift = async (hubAhead: number) => {
        // A little spread between the others, as real clocks have.
        for (const [i, system] of ['server-1', 'a-box', 'b-box'].entries()) {
          // oxlint-disable-next-line no-await-in-loop -- one Report at a time.
          await send(h, time, -(hubAhead * SECOND + (i - 1) * 500), system);
        }
        await send(h, time, 0, 'laptop-1');
        await evaluate(h, time);
        time += MINUTE;
        return (await open(h)).map((row) => `${row.system}:${row.subject}:${row.level}`);
      };

      expect(await drift(29)).toEqual([]);
      expect(await drift(31)).toEqual(['laptop-1:hub:note']);
      expect(await drift(33)).toEqual(['laptop-1:hub:note']);
      expect(await drift(27)).toEqual(['laptop-1:hub:note']);
      expect(await drift(24)).toEqual([]);
    });
  });
});
