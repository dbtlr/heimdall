import { expect, test } from 'bun:test';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };
import { versionLine } from './version.ts';

test('version line names the Hub release and the Report schema it accepts', () => {
  expect(versionLine()).toBe(
    `heimdall-hub ${packageJson.version} (Report schema v${REPORT_SCHEMA_VERSION})`,
  );
});
