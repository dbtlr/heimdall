import { test } from 'bun:test';

import { BROWSER_TEST_TIMEOUT_MS, runInBrowser, testBrowser } from './browser-test.ts';

test.skipIf(testBrowser === null)(
  'the jump box opens on a slash, lists matches as a combobox, moves with arrows, opens with Enter, and closes with Escape',
  async () => {
    if (testBrowser === null) {
      throw new Error('Set HEIMDALL_TEST_BROWSER to a Chromium executable.');
    }
    await runInBrowser(
      testBrowser,
      new URL('jump-box.browser.tsx', import.meta.url),
      'Jump box DOM tests passed',
    );
  },
  BROWSER_TEST_TIMEOUT_MS,
);
