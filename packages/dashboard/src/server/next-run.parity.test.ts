import { expect, test } from 'bun:test';

import { latestScheduledTime } from '../../../hub/src/schedule.ts';
import { nextScheduledTime } from './next-run.ts';

// next-run.ts copies the Hub's reading of a schedule (packages/hub/src/schedule.ts).
// The Hub answers the latest scheduled time at or before an instant; the
// dashboard answers the first one after. They agree when the Hub finds the
// dashboard's next time to be a scheduled time, with none between `after` and it.
const SCHEDULES = [
  [{ hour: 3, minute: 0 }],
  [{ hour: 23, minute: 30, weekday: 0 }],
  [{ day: 1, hour: 0, minute: 0 }],
  [{ minute: 15 }],
  [
    { hour: 2, minute: 30 },
    { hour: 14, minute: 0, weekday: 3 },
  ],
];
// Zones ahead of and behind UTC, one whose clock skips midnight, and UTC.
const ZONES = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'America/Santiago'];
// Around the 2026 clock changes of those zones, and a plain day.
const AFTERS = [
  Date.UTC(2026, 2, 8, 6, 59),
  Date.UTC(2026, 2, 29, 0, 59),
  Date.UTC(2026, 8, 6, 3, 30),
  Date.UTC(2026, 9, 25, 0, 30),
  Date.UTC(2026, 10, 1, 5, 59),
  Date.UTC(2026, 5, 17, 12, 0),
];

test("the dashboard's next scheduled time is the Hub's, for every schedule, zone, and clock change", () => {
  for (const schedule of SCHEDULES) {
    for (const timeZone of ZONES) {
      for (const after of AFTERS) {
        const next = nextScheduledTime({ after, schedule, timeZone });
        if (next === undefined) {
          throw new Error(`no next time for ${JSON.stringify(schedule)} in ${timeZone}`);
        }
        expect(next).toBeGreaterThan(after);
        expect(
          latestScheduledTime({ atOrBefore: next, notBefore: after, schedule, timeZone }),
        ).toBe(next);
        const between = latestScheduledTime({
          atOrBefore: next - 1,
          notBefore: after,
          schedule,
          timeZone,
        });
        expect(between === undefined || between <= after).toBe(true);
      }
    }
  }
});
