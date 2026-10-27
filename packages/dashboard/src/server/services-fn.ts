import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readServiceAttentionCount, readServices } from './services.ts';

export const getServices = createServerFn({ method: 'GET' }).handler(async () => ({
  now: Date.now(),
  services: await readServices(await database()),
}));

export const getServiceAttentionCount = createServerFn({ method: 'GET' }).handler(async () =>
  readServiceAttentionCount(await database()),
);
