import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readJobs } from './jobs.ts';

// The Jobs page, read at the server's clock.
export const getJobs = createServerFn({ method: 'GET' }).handler(async () =>
  readJobs(await database(), Date.now()),
);
