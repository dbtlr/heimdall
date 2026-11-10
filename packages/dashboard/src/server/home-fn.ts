import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { parseGlanceInput } from './fleet-overview.ts';
import { readHome, readSystemTiles } from './home.ts';

// Home, with the unpaired Systems when asked for, read at the server's clock.
export const getHome = createServerFn({ method: 'GET' })
  .validator(parseGlanceInput)
  .handler(async ({ data }) => readHome(await database(), { ...data, now: Date.now() }));

// The Systems as tiles, with the unpaired Systems when asked for, read at the
// server's clock.
export const getSystemTiles = createServerFn({ method: 'GET' })
  .validator(parseGlanceInput)
  .handler(async ({ data }) => readSystemTiles(await database(), { ...data, now: Date.now() }));
