import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import {
  parseGlanceInput,
  parseOverviewInput,
  readFleetGlance,
  readFleetOverview,
} from './fleet-overview.ts';

// The Fleet glance, with the unpaired Systems when asked for, read at the
// server's clock.
export const getFleetGlance = createServerFn({ method: 'GET' })
  .validator(parseGlanceInput)
  .handler(async ({ data }) => readFleetGlance(await database(), { ...data, now: Date.now() }));

// The Fleet overview over `range` (24h when none is given), with the unpaired
// Systems when asked for, read at the server's clock.
export const getFleetOverview = createServerFn({ method: 'GET' })
  .validator(parseOverviewInput)
  .handler(async ({ data }) => readFleetOverview(await database(), { ...data, now: Date.now() }));
