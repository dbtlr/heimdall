import { expect, test } from 'bun:test';

import { isRedirect } from '@tanstack/react-router';

import { toActivity } from './compare.tsx';

// The redirect TanStack Router throws carries what it was built with on options.
type RedirectOptions = { options: { search: unknown; to: unknown } };

const redirectOf = (search: Record<string, unknown>): unknown => {
  try {
    toActivity({ search });
  } catch (error) {
    return error;
  }
  return undefined;
};

test.each([
  [{}, '24h'],
  [{ range: '6h' }, '24h'],
  [{ range: '12h', unpaired: true }, '24h'],
  [{ range: '24h' }, '24h'],
  [{ range: '7d', unpaired: true }, '7d'],
  [{ range: 'nope' }, '24h'],
])('opening /compare with %o redirects to /activity on the %s range', (search, range) => {
  const thrown = redirectOf(search);
  expect(isRedirect(thrown)).toBe(true);
  expect((thrown as RedirectOptions).options).toMatchObject({ to: '/activity' });
  expect((thrown as RedirectOptions).options.search).toEqual({ range });
});
