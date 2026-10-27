import { expect, test } from 'bun:test';

import { groupByRaisedDay } from './timeline-days.ts';

const at = (month: number, day: number, hour: number, minute = 0) =>
  Date.UTC(2026, month - 1, day, hour, minute);
const entry = (raisedAt: number) => ({ raisedAt });
const headings = (groups: { heading: string }[]) => groups.map((group) => group.heading);

test('an empty list has no day groups', () => {
  expect(groupByRaisedDay([], at(10, 27, 12), 'UTC')).toEqual([]);
});

test('days read Today, Yesterday, then weekday and date, keeping the order given', () => {
  const [a, b, c, d] = [
    entry(at(10, 27, 9)),
    entry(at(10, 27, 1)),
    entry(at(10, 26, 23)),
    entry(at(10, 20, 8)),
  ];
  const groups = groupByRaisedDay([a, b, c, d], at(10, 27, 12), 'UTC');
  expect(headings(groups)).toEqual(['Today', 'Yesterday', 'Tuesday 20 Oct']);
  expect(groups.map((group) => group.entries)).toEqual([[a, b], [c], [d]]);
});

test('the day is the one in the viewer zone, not UTC', () => {
  // 23:00 UTC on the 26th is already the 27th in Tokyo.
  const groups = groupByRaisedDay([entry(at(10, 26, 23))], at(10, 27, 1), 'Asia/Tokyo');
  expect(headings(groups)).toEqual(['Today']);
});

test('a 25-hour DST day stays one group', () => {
  // Chicago falls back on 2026-11-01, so that day runs 05:00Z to 06:00Z the next.
  const now = at(11, 2, 18);
  const entries = [
    entry(at(11, 2, 6, 30)),
    entry(at(11, 2, 5, 30)),
    entry(at(11, 1, 5, 30)),
    entry(at(11, 1, 4, 30)),
  ];
  const groups = groupByRaisedDay(entries, now, 'America/Chicago');
  expect(headings(groups)).toEqual(['Today', 'Yesterday', 'Saturday 31 Oct']);
  expect(groups.map((group) => group.entries.length)).toEqual([1, 2, 1]);
});
