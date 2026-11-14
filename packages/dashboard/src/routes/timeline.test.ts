import { expect, test } from 'bun:test';

import { isRedirect } from '@tanstack/react-router';

import { toActivity } from './timeline.tsx';

test('opening /timeline redirects to /activity, keeping the System', () => {
  let thrown: unknown;
  try {
    toActivity({ search: { system: 'server-1' } });
  } catch (error) {
    thrown = error;
  }
  expect(isRedirect(thrown)).toBe(true);
  expect(thrown).toMatchObject({ options: { search: { system: 'server-1' }, to: '/activity' } });
});
