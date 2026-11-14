import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseGlanceInput, readFleetGlance } from './fleet-overview.ts';

// The Fleet glance, with the unpaired Systems when asked for, read at the
// server's clock.
export const getFleetGlance = createServerFn({ method: 'GET' })
  .validator(parseGlanceInput)
  .handler(async ({ data }) => readFleetGlance(await database(), { ...data, now: Date.now() }));
