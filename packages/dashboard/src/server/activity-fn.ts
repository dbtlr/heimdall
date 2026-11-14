import { createServerFn } from '@tanstack/react-start';

import { isActivityRange } from './activity-types.ts';
import type { ActivityRange } from './activity-types.ts';
import { readActivity } from './activity.ts';
import { database } from './database.ts';

// Every change over `range`, read at the server's clock.
export const getActivity = createServerFn({ method: 'GET' })
  .validator((input: { range: ActivityRange }) => {
    if (!isActivityRange(input.range)) {
      throw new Error('The range is not one of 24h, 7d, 30d.');
    }
    return input;
  })
  .handler(async ({ data }) =>
    readActivity(await database(), { now: Date.now(), range: data.range }),
  );
