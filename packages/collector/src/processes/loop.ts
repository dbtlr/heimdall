import type { HarnessProcessesSection } from '@heimdall/schema';

import { darwinReader } from './darwin.ts';
import { linuxReader } from './linux.ts';
import type { ProcessSamplingReader } from './table.ts';

// Where the reporter reads the Harness processes from, and tells which section
// the Hub acknowledged.
export type HarnessProcessesSource = {
  latest: () => HarnessProcessesSection | undefined;
  settled: (delivered: HarnessProcessesSection) => void;
};

// The reader of the System this process runs on.
export const systemReader = (platform: 'darwin' | 'linux'): Promise<ProcessSamplingReader> =>
  platform === 'darwin' ? Promise.resolve(darwinReader()) : linuxReader();
