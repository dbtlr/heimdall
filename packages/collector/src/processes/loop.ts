import { SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { HarnessProcessesSection } from '@heimdall/schema';
import { every } from '@heimdall/service';

import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import { darwinReader } from './darwin.ts';
import { linuxReader } from './linux.ts';
import type { ProcessReader } from './table.ts';
import { createProcessTracker } from './tracker.ts';

// Where the reporter reads the Harness processes from, and tells which section
// the Hub acknowledged.
export type HarnessProcessesSource = {
  latest: () => HarnessProcessesSection | undefined;
  settled: (delivered: HarnessProcessesSection) => void;
};

// The reader of the System this process runs on.
export const systemReader = (platform: 'darwin' | 'linux'): Promise<ProcessReader> =>
  platform === 'darwin' ? Promise.resolve(darwinReader()) : linuxReader();

// Looks at the Harness processes at start and at every Vitals interval, after
// the last look finishes. A tick that fails costs that tick, and the first
// failure of a run of them is warned about. The returned function stops the loop
// and waits for a tick in flight.
export const startProcessTracking = async ({
  intervalMs = SAMPLE_INTERVAL_MS,
  log,
  now,
  platform,
  reader,
}: {
  intervalMs?: number;
  log: Log;
  now: () => number;
  platform: 'darwin' | 'linux';
  reader?: ProcessReader;
}) => {
  const tracker = createProcessTracker({ now, reader: reader ?? (await systemReader(platform)) });
  let failing = false;
  const stop = every({
    intervalMs,
    onError: (error) => {
      if (!failing) {
        log.warn(`Could not look at the Harness processes: ${describeError(error)}`);
      }
      failing = true;
    },
    task: async () => {
      await tracker.tick();
      failing = false;
    },
  });
  return { latest: tracker.latest, settled: tracker.settled, stop };
};
