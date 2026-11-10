import { test } from 'bun:test';

import { BROWSER_TEST_TIMEOUT_MS, runInBrowser, testBrowser } from './browser-test.ts';

test.skipIf(testBrowser === null)(
  'Service filter sheet drafts, dismissals, apply, reopening, and URL clearing in the DOM',
  async () => {
    if (testBrowser === null) {
      throw new Error('Set HEIMDALL_TEST_BROWSER to a Chromium executable.');
    }
    await runInBrowser(
      testBrowser,
      new URL('service-filters.browser.tsx', import.meta.url),
      'Service filter DOM tests passed',
    );
  },
  BROWSER_TEST_TIMEOUT_MS,
);
