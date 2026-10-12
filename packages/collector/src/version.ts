import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

// What `heimdall-collector --version` prints after Loom's `<name> v<version>`.
// Fleet reads the release (the second word) and compares it with the one it
// selected for the System.
export const versionPostfix = `(Report schema v${REPORT_SCHEMA_VERSION})`;
