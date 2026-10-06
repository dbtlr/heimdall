import { afterAll } from 'bun:test';

import { stopTestServer } from './postgres.ts';

// A preload's hooks are global, so this runs once after the last test file.
afterAll(stopTestServer);
