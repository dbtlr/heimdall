import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseOverviewInput, readFleetOverview } from './fleet-overview.ts';

// The Fleet overview over `range` (24h when none is given), with the unpaired
// Systems when asked for, read at the server's clock.
export const getFleetOverview = createServerFn({ method: 'GET' })
  .validator(parseOverviewInput)
  .handler(async ({ data }) => readFleetOverview(await database(), { ...data, now: Date.now() }));
