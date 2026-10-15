import { createServerFn } from '@tanstack/react-start';

import { parseAgentsInput } from '../lib/agents-search.ts';
import { readAgentsOverview } from './agents-overview.ts';
import { database } from './database.ts';

export const getAgentsOverview = createServerFn({ method: 'GET' })
  .validator(parseAgentsInput)
  .handler(async ({ data }) => readAgentsOverview(await database(), { ...data, now: Date.now() }));
