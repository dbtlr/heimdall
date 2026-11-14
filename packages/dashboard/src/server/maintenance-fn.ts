import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readMaintenance } from './maintenance.ts';

// The Maintenance page, read at the server's clock.
export const getMaintenance = createServerFn({ method: 'GET' }).handler(async () =>
  readMaintenance(await database(), Date.now()),
);
