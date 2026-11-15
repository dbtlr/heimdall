import { createServerFn } from '@tanstack/react-start';

import { parseAgentsInput } from '../lib/agents-search.ts';
import { database } from './database.ts';
import { readProjectPage } from './project-view.ts';

export const getProjectView = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const period = parseAgentsInput(input);
    if (
      typeof input !== 'object' ||
      input === null ||
      !('name' in input) ||
      typeof input.name !== 'string'
    ) {
      throw new Error('Invalid project');
    }
    const { range, timeZone } = period;
    return { name: input.name, range, timeZone };
  })
  .handler(async ({ data }) => readProjectPage(await database(), { ...data, now: Date.now() }));
