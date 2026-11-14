import { expect, test } from 'bun:test';

import { isRedirect } from '@tanstack/react-router';

import { toActivity } from './timeline.tsx';

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
  expect(kept).toMatchObject({ options: { search: { system: 'server-1' }, to: '/activity' } });
  expect(redirectOf({})).toMatchObject({ options: { search: {}, to: '/activity' } });
});
