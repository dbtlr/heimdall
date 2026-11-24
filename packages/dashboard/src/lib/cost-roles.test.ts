import { describe, expect, test } from 'bun:test';

import {
  costClassColor,
  costClassLabel,
  listSeats,
  roleClassOf,
  roleText,
  SEATS_LISTED,
  shadeSeats,
} from './cost-roles.ts';

describe('roleClassOf', () => {
  test('takes a class the dashboard knows and refuses any other by name', () => {
    expect(roleClassOf('review')).toBe('review');
    expect(() => roleClassOf('audit')).toThrow(
      'The Hub holds a role class audit, which the dashboard does not know.',
    );
  });
});

describe('costClassLabel', () => {
  test('names each class of the split', () => {
    expect(costClassLabel('main')).toBe('Main');
    expect(costClassLabel('review')).toBe('Review');
    expect(costClassLabel('delegated')).toBe('Delegated');
  });
});

describe('costClassColor', () => {
  test('gives main the plot color and delegated the first series color', () => {
    expect(costClassColor('main')).toBe('var(--plot)');
    expect(costClassColor('delegated')).toBe('var(--series-1)');
    expect(costClassColor('review')).toBe('var(--review-1)');
  });
});

describe('roleText', () => {
  test('joins a review role and its seat with a middle dot', () => {
    expect(roleText('review', 'breaker')).toBe('review · breaker');
  });

  test('names an unknown seat on a review role', () => {
    expect(roleText('review', null)).toBe('review · seat unknown');
  });

  test('shows any other role alone', () => {
    expect(roleText('implementation', null)).toBe('implementation');
  });

  test('gives no text for a conversation with no role', () => {
    expect(roleText(null, null)).toBeNull();
  });
});

describe('shadeSeats', () => {
  test('orders known seats by cost, then puts the unknown seat last', () => {
    const shaded = shadeSeats([
      { cost: 500, seat: null },
      { cost: 96.4, seat: 'architect' },
      { cost: 121.85, seat: 'breaker' },
    ]);
    expect(shaded.map((row) => row.seat)).toEqual(['breaker', 'architect', null]);
  });

  test('gives the three costliest seats their own shade and the rest one shared shade', () => {
    const shaded = shadeSeats([
      { cost: 5, seat: 'breaker' },
      { cost: 4, seat: 'architect' },
      { cost: 3, seat: 'verifier' },
      { cost: 2, seat: 'design-rater' },
      { cost: 1, seat: 'exitcritic' },
    ]);
    expect(shaded.map((row) => row.shade)).toEqual([
      'var(--review-1)',
      'var(--review-2)',
      'var(--review-3)',
      'var(--review-other)',
      'var(--review-other)',
    ]);
  });

  test('hatches the unknown seat whatever its rank', () => {
    const [unknown] = shadeSeats([{ cost: 1, seat: null }]);
    expect(unknown?.shade).toBe('var(--review-unknown)');
  });

  test('breaks a cost tie by seat name, so the order is stable', () => {
    const shaded = shadeSeats([
      { cost: 2, seat: 'verifier' },
      { cost: 2, seat: 'architect' },
    ]);
    expect(shaded.map((row) => row.seat)).toEqual(['architect', 'verifier']);
  });

  test('keeps the fields of each row it is given', () => {
    const [row] = shadeSeats([{ cost: 3, requests: 12, seat: 'breaker' }]);
    expect(row).toEqual({ cost: 3, requests: 12, seat: 'breaker', shade: 'var(--review-1)' });
  });
});

const seats = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    cost: 100 - index,
    seat: `seat-${String(index)}`,
  }));

describe('listSeats', () => {
  test('lists six known seats in full, the unknown seat last', () => {
    const lines = listSeats([{ cost: 500, seat: null }, ...seats(SEATS_LISTED)]);
    expect(lines.map(({ key }) => key)).toEqual([
      'seat:seat-0',
      'seat:seat-1',
      'seat:seat-2',
      'seat:seat-3',
      'seat:seat-4',
      'seat:seat-5',
      'unknown',
    ]);
  });

  test('past six known seats, keeps five and rolls the rest into one line before the unknown seat', () => {
    const lines = listSeats([{ cost: 500, seat: null }, ...seats(SEATS_LISTED + 1)]);
    expect(
      lines.slice(4).map(({ cost, name, seats: rolled, shade }) => [name, cost, rolled, shade]),
    ).toEqual([
      ['seat-4', 96, ['seat-4'], 'var(--review-other)'],
      ['2 more seats', 95 + 94, ['seat-5', 'seat-6'], 'var(--review-other)'],
      ['seat unknown', 500, [null], 'var(--review-unknown)'],
    ]);
  });
});
