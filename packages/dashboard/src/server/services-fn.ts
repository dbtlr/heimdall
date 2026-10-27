import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readServiceAttentionCount, readServices } from './services.ts';

export const getServices = createServerFn({ method: 'GET' }).handler(async () => {
  const now = Date.now();
  return { now, services: await readServices(await database(), now) };
});

export const getServiceAttentionCount = createServerFn({ method: 'GET' }).handler(async () =>
  readServiceAttentionCount(await database()),
);
