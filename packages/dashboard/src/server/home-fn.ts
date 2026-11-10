import { createServerFn } from '@tanstack/react-start';

import { validZone } from '../lib/agents-search.ts';
import { database } from './database.ts';
import { parseGlanceInput } from './fleet-overview.ts';
import { readHome, readSystemTiles } from './home.ts';

// What Home asks for: the unpaired Systems or not, and the viewer's time zone
// once it is known, which agent work is counted in.
const parseHomeInput = (input: unknown) => ({
  ...parseGlanceInput(input),
  timeZone:
    typeof input === 'object' && input !== null && 'timeZone' in input
      ? validZone(input.timeZone)
      : undefined,
});

// Home, with the unpaired Systems when asked for, read at the server's clock.
export const getHome = createServerFn({ method: 'GET' })
  .validator(parseHomeInput)
  .handler(async ({ data }) => readHome(await database(), { ...data, now: Date.now() }));

// The Systems as tiles, with the unpaired Systems when asked for, read at the
// server's clock.
export const getSystemTiles = createServerFn({ method: 'GET' })
  .validator(parseGlanceInput)
  .handler(async ({ data }) => readSystemTiles(await database(), { ...data, now: Date.now() }));
