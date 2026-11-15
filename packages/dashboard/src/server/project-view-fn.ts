import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { parseAgentsInput } from '../lib/agents-search.ts';
import { database } from './database.ts';
import { readProjectView } from './project-view.ts';

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
    const { range, timeZone, ...table } = period;
    return { name: input.name, range, table, timeZone };
  })
  .handler(async ({ data }) => {
    const view = await readProjectView(await database(), { ...data, now: Date.now() });
    if (view === undefined) {
      throw notFound();
    }
    return view;
  });
