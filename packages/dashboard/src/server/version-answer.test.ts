import { expect, test } from 'bun:test';

import { versionAnswer } from './version-answer.ts';

test('answers the build and version the server runs, never to be cached', async () => {
  const response = versionAnswer({ build: '1.2.3+abc', version: '1.2.3' });

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ build: '1.2.3+abc', version: '1.2.3' });
});
