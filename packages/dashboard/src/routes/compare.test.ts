import { expect, test } from 'bun:test';

import { isRedirect } from '@tanstack/react-router';

import { toActivity } from './compare.tsx';

test('opening /compare redirects to /activity, whatever its old range or unpaired switch', () => {
  let thrown: unknown;
  try {
    toActivity();
  } catch (error) {
    thrown = error;
  }
  expect(isRedirect(thrown)).toBe(true);
  expect((thrown as { options: { to: unknown } }).options.to).toBe('/activity');
});
