import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

import packageJson from '../package.json' with { type: 'json' };

// The dashboard's release version, without the leading `v`. It shares the
// Collector's and the Hub's.
export const DASHBOARD_VERSION: string = packageJson.version;

// The id `vite.config.ts` gives a build: its release and when it was built, so
// two builds of one release differ and a page can tell it runs an older one.
export const buildId = (version: string, builtAt: number): string =>
  `${version}+${builtAt.toString(36)}`;

// This build's id, which Vite writes into the pages and the server alike. Code
// Vite did not build, such as the command line and tests, has the release alone.
export const DASHBOARD_BUILD: string =
  import.meta.env.HEIMDALL_DASHBOARD_BUILD ?? DASHBOARD_VERSION;

// What `heimdall-dashboard --version` prints after Loom's `<name> v<version>`,
// the same postfix as the Hub's and the Collector's, so a provisioner reads
// every Heimdall binary's release from the second word alike.
export const versionPostfix = `(Report schema v${REPORT_SCHEMA_VERSION})`;
