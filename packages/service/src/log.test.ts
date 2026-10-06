import { expect, test } from 'bun:test';

import { runtimeLog, timestamped } from './log.ts';

const NOW = Date.UTC(2026, 9, 6, 12, 30, 5, 123);

test('a runtime line starts with its ISO 8601 UTC time', () => {
  expect(timestamped('Listening on http://127.0.0.1:8080/.', NOW)).toBe(
    '2026-10-06T12:30:05.123Z Listening on http://127.0.0.1:8080/.',
  );
});

test('the runtime log prints timestamped lines and marks warnings', async () => {
  const printed: string[] = [];
  const log = runtimeLog({
    fatal: () => {
      throw new Error('not fatal');
    },
    now: () => NOW,
    print: async (line) => void printed.push(line),
  });

  await log.info('Sampling server-1.');
  await log.warn('Pushing to the Hub failed.');

  expect(printed).toEqual([
    '2026-10-06T12:30:05.123Z Sampling server-1.',
    '2026-10-06T12:30:05.123Z warning: Pushing to the Hub failed.',
  ]);
});

test('a fatal runtime line carries its time too', () => {
  const fatal: string[] = [];
  const log = runtimeLog({
    fatal: (line) => {
      fatal.push(line);
      throw new Error(line);
    },
    now: () => NOW,
    print: async () => {},
  });

  expect(() => log.fatal('Could not prepare the database: refused')).toThrow();
  expect(fatal).toEqual(['2026-10-06T12:30:05.123Z Could not prepare the database: refused']);
});
