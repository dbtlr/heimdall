import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { field } from './hub-rows.ts';
import { readPinnedMoment } from './pinned-moment.ts';

// The Sessions running at `at`, and `system`'s Vitals then.
export const getPinnedMoment = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const at = field(input, 'at');
    const system = field(input, 'system');
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw new TypeError('The pinned moment needs a time.');
    }
    return { at, system: typeof system === 'string' ? system : undefined };
  })
  .handler(async ({ data }) => readPinnedMoment(await database(), data));
