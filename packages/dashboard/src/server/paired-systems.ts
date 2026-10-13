import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { listPairedSystems } from './systems.ts';

// Every paired System and when it was last seen, plus the server's clock so
// "12 s ago" reads the same on the server and in the browser.
export const getPairedSystems = createServerFn({ method: 'GET' }).handler(async () => ({
  now: Date.now(),
  systems: await listPairedSystems(await database()),
}));
