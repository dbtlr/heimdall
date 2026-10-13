import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseOverviewInput, readFleetOverview } from './fleet-overview.ts';

// The Fleet overview over `range` (24h when none is given), with the unpaired
// Systems when asked for, read at the server's clock and in the server's time
// zone, so the server and the browser format times alike.
export const getFleetOverview = createServerFn({ method: 'GET' })
  .validator(parseOverviewInput)
  .handler(async ({ data }) =>
    readFleetOverview(await database(), {
      ...data,
      now: Date.now(),
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
