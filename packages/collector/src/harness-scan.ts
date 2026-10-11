import type { HarnessesSection } from '@heimdall/schema';
import { every } from '@heimdall/service';

import type { Log } from './collector.ts';
import { describeError } from './errors.ts';
import { findHarnessInstalls } from './harness-installs.ts';
import type { InstallReader } from './harness-installs.ts';

// How often the Collector looks for Harness installs. Installs change when a
// person or a provisioner upgrades a tool, not by the minute.
export const HARNESS_SCAN_INTERVAL_MS = 10 * 60_000;

// Where the reporter reads the Harness installs from: the section the last
// scan built, or undefined until the first scan finishes.
export type HarnessesSource = { latest: () => HarnessesSection | undefined };

// Looks for Harness installs and keeps the section for them. `latest` answers
// the same object until the installs differ, so the reporter can tell by
// identity that nothing changed. A directory that cannot be read costs only
// what is under it (see `findHarnessInstalls`).
export const createHarnessScan = ({
  home,
  platform,
  reader,
}: {
  home: string;
  platform: 'darwin' | 'linux';
  reader: InstallReader;
}) => {
  let latest: HarnessesSection | undefined;
  let digest: string | undefined;
  return {
    latest: () => latest,
    tick: async () => {
      const installs = await findHarnessInstalls({ home, platform, reader });
      const next = JSON.stringify(installs);
      if (next !== digest) {
        digest = next;
        latest = { installs };
      }
    },
  };
};

// Scans for Harness installs at start and every interval after a scan
// finishes. The returned function stops the loop and waits for a scan in flight.
export const startHarnessScan = ({
  intervalMs = HARNESS_SCAN_INTERVAL_MS,
  log,
  ...options
}: Parameters<typeof createHarnessScan>[0] & { intervalMs?: number; log: Log }) => {
  const scan = createHarnessScan(options);
  const stop = every({
    intervalMs,
    onError: (error) => log.warn(`Looking for Harness installs failed: ${describeError(error)}`),
    task: scan.tick,
  });
  return { latest: scan.latest, stop };
};
