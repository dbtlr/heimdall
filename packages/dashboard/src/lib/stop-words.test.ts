import { expect, test } from 'bun:test';

import { stopWords } from './stop-words.ts';

const finished = { lasted: 4 * 60_000, ongoing: false, restarts: 0, service: 'web' };

test('a finished stop says how long it lasted, and a stop under way only that it stopped', () => {
  expect(stopWords(finished)).toBe('web stopped for 4 min');
  expect(stopWords({ ...finished, lasted: undefined })).toBe('web stopped, end unknown');
  expect(stopWords({ ...finished, ongoing: true, restarts: 2 })).toBe('web stopped');
});

test("a stop counts the supervisor's restarts, one restart in the singular", () => {
  expect(stopWords({ ...finished, restarts: 1 })).toBe('web stopped for 4 min (restarted 1 time)');
  expect(stopWords({ ...finished, restarts: 3 })).toBe('web stopped for 4 min (restarted 3 times)');
});
