import { test } from 'bun:test';

import { BROWSER_TEST_TIMEOUT_MS, runInBrowser, testBrowser } from './browser-test.ts';

test.skipIf(testBrowser === null)(
  "the overview's time axis is a slider whose arrow, Shift, Home, and End keys pin a sample",
  async () => {
    if (testBrowser === null) {
      throw new Error('Set HEIMDALL_TEST_BROWSER to a Chromium executable.');
    }
    await runInBrowser(
      testBrowser,
      new URL('system-overview.browser.tsx', import.meta.url),
      'System overview DOM tests passed',
    );
  },
  BROWSER_TEST_TIMEOUT_MS,
);
