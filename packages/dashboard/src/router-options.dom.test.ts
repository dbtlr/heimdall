import { test } from 'bun:test';

import { BROWSER_TEST_TIMEOUT_MS, runInBrowser, testBrowser } from './components/browser-test.ts';

test.skipIf(testBrowser === null)(
  'a page read that fails on a refresh shows its error inside the layout, and the next read recovers',
  async () => {
    if (testBrowser === null) {
      throw new Error('Set HEIMDALL_TEST_BROWSER to a Chromium executable.');
    }
    await runInBrowser(
      testBrowser,
      new URL('router-options.browser.tsx', import.meta.url),
      'Router error DOM tests passed',
    );
  },
  BROWSER_TEST_TIMEOUT_MS,
);
