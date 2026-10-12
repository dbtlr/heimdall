import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };

// The Hub's release version, without the leading `v`.
export const HUB_VERSION: string = packageJson.version;

// What `heimdall-hub --version` prints after Loom's `<name> v<version>`.
// Fleet reads the release (the second word) and compares it with the one it
// selected for the Hub's System.
export const versionPostfix = `(Report schema v${REPORT_SCHEMA_VERSION})`;
