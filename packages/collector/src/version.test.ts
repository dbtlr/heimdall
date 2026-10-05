import { expect, test } from 'bun:test';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };
import { versionLine } from './version.ts';

test('version line names the Collector release and the Report schema it speaks', () => {
  expect(versionLine()).toMatch(/^heimdall-collector \d+\.\d+\.\d+ \(Report schema v\d+\)$/);
  expect(versionLine()).toContain(` ${packageJson.version} `);
  expect(versionLine()).toContain(`v${REPORT_SCHEMA_VERSION})`);
});
