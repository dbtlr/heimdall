import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readHubStatus, readHubVersion } from './hub-status.ts';

export const getHubStatus = createServerFn({ method: 'GET' }).handler(async () =>
  readHubStatus(await database(), Date.now()),
);

// The Hub version for the desktop footer, undefined when the Hub has not
// recorded one.
export const getHubVersion = createServerFn({ method: 'GET' }).handler(async () =>
  readHubVersion(await database()),
);
