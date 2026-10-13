import { expect, test } from 'bun:test';

import { startHub } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

import { healthAnswer } from './health.ts';

const read = async (response: Response) => ({
  body: (await response.json()) as unknown,
  status: response.status,
});

test('answers 200 with its version when the database answers', async () => {
  await using h = await startHub();

  const answer = await healthAnswer({
    database: () => Promise.resolve(h.db.sql),
    version: '0.6.0',
  });

  expect(await read(answer)).toEqual({
    body: { database: 'ok', version: '0.6.0' },
    status: 200,
  });
}, 60_000);

test('answers 503 when the database cannot be opened', async () => {
  const answer = await healthAnswer({
    database: () => Promise.reject(new Error('No database URL')),
    version: '0.6.0',
  });

  expect(await read(answer)).toEqual({
    body: { database: 'not answering', version: '0.6.0' },
    status: 503,
  });
});

test('answers 503 when the database does not answer in time', async () => {
  // Answers long after the 10 ms the check waits.
  const silent = (() => Bun.sleep(1000)) as unknown as SQL;

  const answer = await healthAnswer({
    database: () => Promise.resolve(silent),
    timeoutMs: 10,
    version: '0.6.0',
  });

  expect(await read(answer)).toEqual({
    body: { database: 'not answering', version: '0.6.0' },
    status: 503,
  });
});
