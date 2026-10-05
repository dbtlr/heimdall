import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };

// The line `heimdall-hub --version` prints. Fleet compares the release in it
// against the release it selected for Asgard.
export const versionLine = (): string =>
  `heimdall-hub ${packageJson.version} (Report schema v${REPORT_SCHEMA_VERSION})`;
