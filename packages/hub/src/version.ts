import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };

// The Hub's release version, without the leading `v`.
export const HUB_VERSION: string = packageJson.version;

// The line `heimdall-hub --version` prints, in Loom's `<name> v<version>` form.
// Fleet reads the release (the second word) and compares it with the one it
// selected for the Hub's System.
export const versionLine = (): string =>
  `heimdall-hub v${HUB_VERSION} (Report schema v${REPORT_SCHEMA_VERSION})`;
