import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readHubStatus } from './hub-status.ts';

export const getHubStatus = createServerFn({ method: 'GET' }).handler(async () =>
  readHubStatus(await database(), Date.now()),
);
