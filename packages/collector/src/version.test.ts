import { expect, test } from 'bun:test';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };
import { versionLine } from './version.ts';

test('version line names the Collector release and the Report schema it speaks', () => {
  expect(versionLine()).toBe(
    `heimdall-collector ${packageJson.version} (Report schema v${REPORT_SCHEMA_VERSION})`,
  );
});
