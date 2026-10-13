import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };

// The dashboard's release version, without the leading `v`. It shares the
// Collector's and the Hub's.
export const DASHBOARD_VERSION: string = packageJson.version;

// What `heimdall-dashboard --version` prints after Loom's `<name> v<version>`,
// the same postfix as the Hub's and the Collector's, so a provisioner reads
// every Heimdall binary's release from the second word alike.
export const versionPostfix = `(Report schema v${REPORT_SCHEMA_VERSION})`;
