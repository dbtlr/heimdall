import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };

// The line `heimdall-collector --version` prints. Fleet compares the release in
// it against the release it selected for the System.
export const versionLine = (): string =>
  `heimdall-collector ${packageJson.version} (Report schema v${REPORT_SCHEMA_VERSION})`;
