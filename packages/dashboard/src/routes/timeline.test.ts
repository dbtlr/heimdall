import { expect, test } from 'bun:test';

import { isRedirect } from '@tanstack/react-router';

import { toActivity } from './timeline.tsx';

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

test('opening /timeline redirects to /activity, keeping the System and dropping the old filters', () => {
  const kept = redirectOf({ level: ['alert'], status: ['open'], system: ['server-1'] });
  expect(isRedirect(kept)).toBe(true);
  expect((kept as RedirectOptions).options).toMatchObject({ to: '/activity' });
  expect((kept as RedirectOptions).options.search).toEqual({ system: 'server-1' });
  const empty = redirectOf({});
  expect(isRedirect(empty)).toBe(true);
  expect((empty as RedirectOptions).options).toMatchObject({ to: '/activity' });
  expect((empty as RedirectOptions).options.search).toEqual({});
});
