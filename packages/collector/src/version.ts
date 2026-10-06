import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };

// The line `heimdall-collector --version` prints, in Loom's `<name> v<version>` form.
// Fleet reads the release (the second word) and compares it with the one it
// selected for the System.
export const versionLine = (): string =>
  `heimdall-collector v${packageJson.version} (Report schema v${REPORT_SCHEMA_VERSION})`;
