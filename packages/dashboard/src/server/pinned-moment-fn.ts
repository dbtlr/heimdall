import { createServerFn } from '@tanstack/react-start';

import { momentInput } from '../lib/activity-moment.ts';
import { database } from './database.ts';
import { readPinnedMoment } from './pinned-moment.ts';

// The Sessions running at `at`, and `system`'s Vitals then, for a time within
// Activity's longest range.
export const getPinnedMoment = createServerFn({ method: 'GET' })
  .validator((input: unknown) => momentInput(input, Date.now()))
  .handler(async ({ data }) => readPinnedMoment(await database(), data));
