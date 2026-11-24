import { describe, expect, test } from 'bun:test';

import type { RoleSplit } from '../server/role-split-types.ts';
import { costByRole, costByRoleNote, missedTagsSentence } from './cost-by-role.ts';

const cost = (pricedCostUsd: number, unpricedRequests = 0) => ({
  pricedCostUsd,
  requests: 10,
  unpricedRequests,
});

const seat = (name: string | null, pricedCostUsd: number) => ({
  seat: name,
  ...cost(pricedCostUsd),
});

const split = (over: Partial<RoleSplit> = {}): RoleSplit => ({
  classes: { delegated: cost(30), main: cost(40), review: cost(30) },
  seats: [seat(null, 5), seat('verifier', 10), seat('breaker', 15)],
  ...over,
});

describe('costByRole', () => {
  test('draws main, each seat costliest first with the unknown seat last, then delegated, as shares of the priced cost', () => {
    const view = costByRole(split());

    expect(view.strip.map(({ key, widthPercent }) => [key, widthPercent])).toEqual([
      ['main', 40],
      ['seat:breaker', 15],
      ['seat:verifier', 10],
      ['unknown', 5],
      ['delegated', 30],
    ]);
    expect(view.strip.map(({ color }) => color)).toEqual([
      'var(--plot)',
      'var(--review-1)',
      'var(--review-2)',
      'var(--review-unknown)',
      'var(--series-1)',
    ]);
    expect(view.seats.map(({ name }) => name)).toEqual(['breaker', 'verifier', 'seat unknown']);
    expect(view.columns.map(({ costUsd, label, percent }) => [label, costUsd, percent])).toEqual([
      ['Main', 40, 40],
      ['Review', 30, 30],
      ['Delegated', 30, 30],
    ]);
  });

  test('a period with no review cost has no seats and no review segment', () => {
    const view = costByRole(
      split({ classes: { delegated: cost(25), main: cost(75), review: cost(0) }, seats: [] }),
    );

    expect(view.seats).toEqual([]);
    expect(view.strip.map(({ key }) => key)).toEqual(['main', 'delegated']);
    expect(view.columns[1]).toMatchObject({ costUsd: 0, percent: 0 });
  });

  test('a period with nothing priced has no strip and no shares', () => {
    const view = costByRole({
      classes: { delegated: cost(0), main: cost(0, 3), review: cost(0) },
      seats: [],
    });

    expect(view.strip).toEqual([]);
    expect(view.columns.map(({ percent }) => percent)).toEqual([undefined, undefined, undefined]);
    expect(view.unpricedRequests).toBe(3);
  });

  test('past six known seats, keeps the five costliest and rolls the rest into one shared row', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const view = costByRole(
      split({ seats: [...names.map((name, index) => seat(name, 10 - index)), seat(null, 1)] }),
    );

    expect(view.seats.map(({ costUsd, name, shade }) => [name, costUsd, shade])).toEqual([
      ['a', 10, 'var(--review-1)'],
      ['b', 9, 'var(--review-2)'],
      ['c', 8, 'var(--review-3)'],
      ['d', 7, 'var(--review-other)'],
      ['e', 6, 'var(--review-other)'],
      ['2 more seats', 9, 'var(--review-other)'],
      ['seat unknown', 1, 'var(--review-unknown)'],
    ]);
  });

  test('leaves a class or seat with no priced cost out of the strip', () => {
    const view = costByRole(
      split({
        classes: { delegated: cost(50), main: cost(0), review: cost(50) },
        seats: [seat('a', 50), seat('b', 0)],
      }),
    );

    expect(view.strip.map(({ key }) => key)).toEqual(['seat:a', 'delegated']);
  });

  test('counts the unpriced requests of every class', () => {
    const view = costByRole(
      split({ classes: { delegated: cost(5, 3), main: cost(1), review: cost(10, 2) } }),
    );

    expect(view.unpricedRequests).toBe(5);
  });

  test('lists six known seats in full', () => {
    const view = costByRole(
      split({ seats: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => seat(name, 5)) }),
    );

    expect(view.seats).toHaveLength(6);
    expect(view.seats.at(-1)?.name).toBe('f');
  });
});

describe('costByRoleNote', () => {
  test('names the period at list price, and any unpriced requests', () => {
    expect(costByRoleNote('30 days', 0)).toBe('30 days, at list price');
    expect(costByRoleNote('Today', 2)).toBe('Today, at list price · at least, 2 requests unpriced');
  });
});

describe('missedTagsSentence', () => {
  test('counts the Sessions with a role that missed their tag', () => {
    expect(missedTagsSentence({ missed: 37, withRole: 212 }, 'in 30 days')).toEqual({
      lead: '37 of 212',
      rest: " Sessions with a role had no session tag and took it from T3's preamble, so their launcher and any review seat are unknown.",
      warn: true,
    });
    expect(missedTagsSentence({ missed: 1, withRole: 4 }, 'today').rest).toContain(
      'so its launcher',
    );
  });

  test('says so when every one had its tag, or there were none', () => {
    expect(missedTagsSentence({ missed: 0, withRole: 12 }, 'today')).toEqual({
      lead: '',
      rest: 'All 12 Sessions with a role had a session tag.',
      warn: false,
    });
    expect(missedTagsSentence({ missed: 0, withRole: 0 }, 'in 7 days').rest).toBe(
      'No Session with a role had a request in 7 days.',
    );
  });
});
