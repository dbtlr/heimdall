import { afterAll, afterEach } from 'bun:test';

import { releaseSharedDatabase, stopTestServer } from './postgres.ts';

// A preload's hooks are global: this runs after every test of every file,
afterEach(releaseSharedDatabase);
// and this once after the last test file.
afterAll(stopTestServer);
