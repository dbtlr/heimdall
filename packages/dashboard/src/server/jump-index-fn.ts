import { createServerFn } from '@tanstack/react-start';

import { database } from './database.ts';
import { readJumpIndex } from './jump-index.ts';

// The jump box's index of names, read at the server's clock.
export const getJumpIndex = createServerFn({ method: 'GET' }).handler(async () =>
  readJumpIndex(await database(), { now: Date.now() }),
);
