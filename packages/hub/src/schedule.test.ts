import { describe, expect, test } from 'bun:test';

import { latestScheduledTime } from './schedule.ts';

const at = (iso: string) => Date.parse(iso);

const FAR_PAST = at('2020-01-01T00:00:00Z');

// The latest time `schedule` names at or before `atOrBefore`, read in `timeZone`.
const latestIn = (
  timeZone: string,
  schedule: Parameters<typeof latestScheduledTime>[0]['schedule'],
  atOrBefore: string,
  notBefore = FAR_PAST,
) => latestScheduledTime({ atOrBefore: at(atOrBefore), notBefore, schedule, timeZone });

describe('latestScheduledTime', () => {
  test('finds the latest daily time at or before the given instant, in the System zone', () => {
    expect(latestIn('America/New_York', [{ hour: 3, minute: 30 }], '2026-10-10T12:00:00Z')).toBe(
      at('2026-10-10T07:30:00Z'),
    );
  });

  test("goes back to the previous day before today's time", () => {
    expect(latestIn('America/New_York', [{ hour: 3, minute: 30 }], '2026-10-10T07:00:00Z')).toBe(
      at('2026-10-09T07:30:00Z'),
    );
  });

  test('counts a time exactly at the instant', () => {
    expect(latestIn('America/New_York', [{ hour: 3, minute: 30 }], '2026-10-10T07:30:00Z')).toBe(
      at('2026-10-10T07:30:00Z'),
    );
  });

  test('finds nothing when the latest time is earlier than the earliest allowed', () => {
    const latest = latestIn(
      'America/New_York',
      [{ hour: 3, minute: 30 }],
      '2026-10-10T12:00:00Z',
      at('2026-10-10T08:00:00Z'),
    );

    expect(latest).toBeUndefined();
  });

  test('takes the latest of several entries', () => {
    const schedule = [
      { hour: 3, minute: 30 },
      { hour: 6, minute: 0 },
    ];

    expect(latestIn('America/New_York', schedule, '2026-10-10T12:00:00Z')).toBe(
      at('2026-10-10T10:00:00Z'),
    );
  });

  test('an entry naming a day of the month and a weekday fires on either', () => {
    const schedule = [{ day: 1, hour: 0, minute: 0, weekday: 0 }];

    // Sunday 4 October, then Thursday 1 October.
    expect(latestIn('America/New_York', schedule, '2026-10-10T12:00:00Z')).toBe(
      at('2026-10-04T04:00:00Z'),
    );
    expect(latestIn('America/New_York', schedule, '2026-10-03T12:00:00Z')).toBe(
      at('2026-10-01T04:00:00Z'),
    );
  });

  test('the month applies to an entry naming a weekday', () => {
    const schedule = [{ hour: 0, minute: 0, month: 9, weekday: 0 }];

    // The last Sunday in September.
    expect(latestIn('America/New_York', schedule, '2026-10-10T12:00:00Z')).toBe(
      at('2026-09-27T04:00:00Z'),
    );
  });

  test('weekday 7 is Sunday', () => {
    expect(latestIn('UTC', [{ hour: 0, minute: 0, weekday: 7 }], '2026-10-10T12:00:00Z')).toBe(
      at('2026-10-04T00:00:00Z'),
    );
  });

  test('an entry naming only a minute fires every hour', () => {
    expect(latestIn('UTC', [{ minute: 15 }], '2026-10-10T12:10:00Z')).toBe(
      at('2026-10-10T11:15:00Z'),
    );
  });

  test('an entry naming only an hour fires every minute of it', () => {
    expect(latestIn('UTC', [{ hour: 3 }], '2026-10-10T12:00:00Z')).toBe(at('2026-10-10T03:59:00Z'));
    expect(latestIn('UTC', [{ hour: 3 }], '2026-10-10T03:20:30Z')).toBe(at('2026-10-10T03:20:00Z'));
  });

  test('a time the clock skips falls an hour later', () => {
    const schedule = [{ hour: 2, minute: 30 }];

    // 02:30 on 8 March does not exist in New York; it falls an hour later.
    expect(latestIn('America/New_York', schedule, '2026-03-08T12:00:00Z')).toBe(
      at('2026-03-08T07:30:00Z'),
    );
    // At 03:10 EDT that time is still to come, so the latest is the day before.
    expect(latestIn('America/New_York', schedule, '2026-03-08T07:10:00Z')).toBe(
      at('2026-03-07T07:30:00Z'),
    );
  });

  test('a skipped time that falls after a later entry is still the latest', () => {
    // 02:30 falls at 03:30 EDT, after 03:15.
    const schedule = [
      { hour: 2, minute: 30 },
      { hour: 3, minute: 15 },
    ];

    expect(latestIn('America/New_York', schedule, '2026-03-08T07:45:00Z')).toBe(
      at('2026-03-08T07:30:00Z'),
    );
  });

  test('a skipped time falls as much later as the clock skips', () => {
    // Lord Howe Island skips 30 minutes: 02:15 falls at 02:45, after 02:40.
    const schedule = [
      { hour: 2, minute: 15 },
      { hour: 2, minute: 40 },
    ];

    expect(latestIn('Australia/Lord_Howe', schedule, '2026-10-03T15:50:00Z')).toBe(
      at('2026-10-03T15:45:00Z'),
    );
  });

  test('a skipped midnight hour falls after the times that follow it', () => {
    // Havana skips from 00:00 to 01:00 on 8 March: 00:30 falls at 01:30 CDT.
    const schedule = [
      { hour: 0, minute: 30 },
      { hour: 1, minute: 10 },
    ];

    expect(latestIn('America/Havana', schedule, '2026-03-08T05:40:00Z')).toBe(
      at('2026-03-08T05:30:00Z'),
    );
  });

  test("a skipped time late in a day can fall after the next day's first times", () => {
    // Nuuk skips from 23:00 on 28 March to 00:00 the next day: Saturday's
    // 23:30 falls at 01:30 UTC, after Sunday's 00:10 at 01:10 UTC.
    const schedule = [
      { hour: 23, minute: 30 },
      { hour: 0, minute: 10 },
    ];

    expect(latestIn('America/Nuuk', schedule, '2026-03-29T01:40:00Z')).toBe(
      at('2026-03-29T01:30:00Z'),
    );
    expect(
      latestIn(
        'America/Nuuk',
        [{ hour: 23, minute: 30 }],
        '2026-03-29T01:40:00Z',
        at('2026-03-29T01:20:00Z'),
      ),
    ).toBe(at('2026-03-29T01:30:00Z'));
  });

  test("during a repeated hour, the first pass of a later time is today's", () => {
    // At 01:10 EST, the second pass, 01:45 EDT has already passed.
    expect(latestIn('America/New_York', [{ hour: 1, minute: 45 }], '2026-11-01T06:10:00Z')).toBe(
      at('2026-11-01T05:45:00Z'),
    );
    // Havana repeats its midnight hour on 1 November.
    expect(latestIn('America/Havana', [{ hour: 0, minute: 45 }], '2026-11-01T05:10:00Z')).toBe(
      at('2026-11-01T04:45:00Z'),
    );
  });

  test('a time the clock repeats falls the first time', () => {
    expect(latestIn('America/New_York', [{ hour: 1, minute: 30 }], '2026-11-01T12:00:00Z')).toBe(
      at('2026-11-01T05:30:00Z'),
    );
  });

  test('finds a leap day years back', () => {
    expect(
      latestIn('UTC', [{ day: 29, hour: 0, minute: 0, month: 2 }], '2026-10-10T12:00:00Z'),
    ).toBe(at('2024-02-29T00:00:00Z'));
  });

  test('finds nothing for an entry that never fires', () => {
    expect(latestIn('UTC', [{ day: 30, month: 2 }], '2026-10-10T12:00:00Z')).toBeUndefined();
  });

  test('refuses a zone the runtime does not know', () => {
    expect(() => latestIn('Mars/Olympus_Mons', [{ minute: 0 }], '2026-10-10T12:00:00Z')).toThrow(
      RangeError,
    );
  });
});

// The definition, by brute force: every wall-clock minute of the days around
// `atOrBefore` that an entry names, resolved as Temporal's `compatible` does,
// and the latest instant in range.
const bruteForce = ({
  atOrBefore,
  notBefore,
  schedule,
  timeZone,
}: Parameters<typeof latestScheduledTime>[0]) => {
  const last = Temporal.Instant.fromEpochMilliseconds(atOrBefore)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .add({ days: 1 });
  let latest: number | undefined;
  for (let back = 0; back < 6; back += 1) {
    const date = last.subtract({ days: back });
    for (let minute = 0; minute < 1440; minute += 1) {
      const fires = schedule.some(
        (e) =>
          (e.hour === undefined || e.hour === Math.floor(minute / 60)) &&
          (e.minute === undefined || e.minute === minute % 60),
      );
      if (fires) {
        const instant = date
          .toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 })
          .toZonedDateTime(timeZone, { disambiguation: 'compatible' }).epochMilliseconds;
        if (
          instant <= atOrBefore &&
          instant >= notBefore &&
          (latest === undefined || instant > latest)
        ) {
          latest = instant;
        }
      }
    }
  }
  return latest;
};

test('agrees with brute force around clock changes in several zones', () => {
  // A seeded generator, so a failure repeats.
  let seed = 39;
  const random = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % n;
  };
  const transitions = [
    ['America/New_York', '2026-03-08T07:00:00Z'],
    ['America/New_York', '2026-11-01T06:00:00Z'],
    ['America/Havana', '2026-03-08T05:00:00Z'],
    ['America/Havana', '2026-11-01T05:00:00Z'],
    ['America/Nuuk', '2026-03-29T01:00:00Z'],
    ['America/Nuuk', '2026-10-25T01:00:00Z'],
    ['Australia/Lord_Howe', '2026-10-03T15:30:00Z'],
    ['Australia/Lord_Howe', '2026-04-04T15:00:00Z'],
    ['Pacific/Apia', '2011-12-30T10:00:00Z'],
    ['Asia/Kathmandu', '2026-10-10T00:00:00Z'],
  ] as const;
  for (const [timeZone, transition] of transitions) {
    for (let i = 0; i < 200; i += 1) {
      // Hours near midnight and the small hours, where clocks change, half the time.
      const hour = () => (random(2) === 0 ? random(24) : [22, 23, 0, 1, 2, 3][random(6)]);
      const schedule = Array.from({ length: 1 + random(3) }, () =>
        random(4) === 0 ? { minute: random(60) } : { hour: hour(), minute: random(60) },
      );
      const atOrBefore = at(transition) + (random(48 * 60) - 24 * 60) * 60_000;
      const notBefore = atOrBefore - random(36 * 60) * 60_000;
      const input = { atOrBefore, notBefore, schedule, timeZone };

      expect({ input, latest: latestScheduledTime(input) }).toEqual({
        input,
        latest: bruteForce(input),
      });
    }
  }
});
