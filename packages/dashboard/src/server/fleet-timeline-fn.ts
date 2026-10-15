import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readFleetTimeline } from './fleet-timeline.ts';

export const getFleetTimeline = createServerFn({ method: 'GET' }).handler(async () =>
  readFleetTimeline(await database(), { now: Date.now() }),
);
