import { test } from 'bun:test';

import { BROWSER_TEST_TIMEOUT_MS, runInBrowser, testBrowser } from './browser-test.ts';

test.skipIf(testBrowser === null)(
  'a link to a slow page shows the line and marks the page busy until it arrives; a quick page and a refresh show nothing',
  async () => {
    if (testBrowser === null) {
      throw new Error('Set HEIMDALL_TEST_BROWSER to a Chromium executable.');
    }
    await runInBrowser(
      testBrowser,
      new URL('navigation-progress.browser.tsx', import.meta.url),
      'Navigation progress DOM tests passed',
    );
  },
  BROWSER_TEST_TIMEOUT_MS,
);
