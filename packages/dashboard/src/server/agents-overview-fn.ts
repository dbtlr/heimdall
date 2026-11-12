import { createServerFn } from '@tanstack/react-start';

import { parseAgentsInput } from '../lib/agents-search.ts';
import { readAgentsOverview } from './agents-overview.ts';
import { database } from './database.ts';

export const getAgentsOverview = createServerFn({ method: 'GET' })
  .validator(parseAgentsInput)
  .handler(async ({ data: { range, timeZone, ...table } }) =>
    readAgentsOverview(await database(), { now: Date.now(), range, table, timeZone }),
  );
