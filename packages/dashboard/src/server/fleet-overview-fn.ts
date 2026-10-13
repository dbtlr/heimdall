import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseRangeInput, readFleetOverview } from './fleet-overview.ts';

// The Fleet overview over `range` (24h when none is given), read at the
// server's clock and in the server's time zone, so the server and the browser
// format times alike.
export const getFleetOverview = createServerFn({ method: 'GET' })
  .validator(parseRangeInput)
  .handler(async ({ data: range }) =>
    readFleetOverview(await database(), {
      now: Date.now(),
      range,
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
