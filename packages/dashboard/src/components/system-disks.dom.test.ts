import { test } from 'bun:test';

import { BROWSER_TEST_TIMEOUT_MS, runInBrowser, testBrowser } from './browser-test.ts';

test.skipIf(testBrowser === null)(
  "the wide Disks card dates an old sample's disks as the System facts do",
  async () => {
    if (testBrowser === null) {
      throw new Error('Set HEIMDALL_TEST_BROWSER to a Chromium executable.');
    }
    await runInBrowser(
      testBrowser,
      new URL('system-disks.browser.tsx', import.meta.url),
      'System disks DOM tests passed',
    );
  },
  BROWSER_TEST_TIMEOUT_MS,
);
