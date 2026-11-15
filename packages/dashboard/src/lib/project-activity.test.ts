import { expect, test } from 'bun:test';

import { laneRows, linkableProject, unionMs } from './project-activity.ts';

test('the union of intervals counts overlapping time once', () => {
  expect(unionMs([])).toBe(0);
  expect(
    unionMs([
      { end: 10, start: 0 },
      { end: 15, start: 5 },
      { end: 40, start: 30 },
      { end: 35, start: 31 },
    ]),
  ).toBe(25);
});

const lane = (sessionId: string, start: number, end: number) => ({
  end,
  harness: 'claude-code',
  sessionId,
  source: 'claude-code',
  start,
  system: 'laptop-1',
});

test('overlapping Sessions stack into rows of their own, and a later interval reuses the first free row', () => {
  const rows = laneRows(
    [lane('a', 0, 10), lane('b', 5, 20), lane('c', 12, 30), lane('a', 40, 50)],
    0,
  );
  expect(
    rows.map((row) => row.map(({ sessionId, start }) => `${sessionId}@${String(start)}`)),
  ).toEqual([['a@0', 'c@12', 'a@40'], ['b@5']]);
});

test('a Session draws one block across gaps narrower than the join width, but never across another Session', () => {
  const rows = laneRows([lane('a', 0, 10), lane('a', 11, 20), lane('a', 40, 50)], 5);
  expect(rows).toEqual([[lane('a', 0, 20), lane('a', 40, 50)]]);
});

test('only a name a path can carry links to a project page', () => {
  expect(['notes app', 'dots.app', '.', '..', '', undefined].map(linkableProject)).toEqual([
    true,
    true,
    false,
    false,
    false,
    false,
  ]);
});
