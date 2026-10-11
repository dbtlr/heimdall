import { setTimeout as sleep } from 'node:timers/promises';

import type { HarnessesSection } from '@heimdall/schema';
import { every } from '@heimdall/service';

import type { Log } from './collector.ts';
import { describeError } from './errors.ts';
import { findHarnessInstalls } from './harness-installs.ts';
import type { InstallEnv, InstallReader } from './harness-installs.ts';

// How often the Collector looks for Harness installs. Installs change when a
// person or a provisioner upgrades a tool, not by the minute.
export const HARNESS_SCAN_INTERVAL_MS = 10 * 60_000;

// Where the reporter reads the Harness installs from: the section the last
// scan built, or undefined until the first scan finishes.
export type HarnessesSource = { latest: () => HarnessesSection | undefined };

// Looks for Harness installs and keeps the section for them. `latest` answers
// the same object until the installs differ, so the reporter can tell by
// identity that nothing changed. A directory that cannot be read costs only
// what is under it, and an install there that its parent directory lists reports
// an unknown version (see `findHarnessInstalls`).
export const createHarnessScan = ({
  env,
  home,
  platform,
  reader,
}: {
  env: InstallEnv;
  home: string;
  platform: 'darwin' | 'linux';
  reader: InstallReader;
}) => {
  let latest: HarnessesSection | undefined;
  let digest: string | undefined;
  return {
    latest: () => latest,
    tick: async () => {
      const installs = await findHarnessInstalls({ env, home, platform, reader });
      const next = JSON.stringify(installs);
      if (next !== digest) {
        digest = next;
        latest = { installs };
      }
    },
  };
};

// How long stopping waits for a scan in flight before leaving it behind, so a
// read that never returns cannot keep the Collector from shutting down.
export const HARNESS_SCAN_STOP_WAIT_MS = 5000;

// Scans for Harness installs at start and every interval after a scan
// finishes. The returned function stops the loop and waits for a scan in
// flight, for at most `stopWaitMs`.
export const startHarnessScan = ({
  intervalMs = HARNESS_SCAN_INTERVAL_MS,
  log,
  stopWaitMs = HARNESS_SCAN_STOP_WAIT_MS,
  ...options
}: Parameters<typeof createHarnessScan>[0] & {
  intervalMs?: number;
  log: Log;
  stopWaitMs?: number;
}) => {
  const scan = createHarnessScan(options);
  const stop = every({
    intervalMs,
    onError: (error) => log.warn(`Looking for Harness installs failed: ${describeError(error)}`),
    task: scan.tick,
  });
  return {
    latest: scan.latest,
    // The timer does not keep the process alive, so a scan that finished in
    // time leaves nothing behind.
    stop: async () => {
      await Promise.race([stop(), sleep(stopWaitMs, undefined, { ref: false })]);
    },
  };
};
