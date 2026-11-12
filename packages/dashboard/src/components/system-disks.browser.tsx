/* oxlint-disable node/no-sync -- React flushSync commits DOM updates before assertions. */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { SystemDetail } from '../server/system-detail-types.ts';
import { SystemDisks } from './system-facts.tsx';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const latest = (t: number): SystemDetail['latest'] => ({
  cpuBusyPercent: 1,
  disks: [{ mount: '/', totalBytes: 100, usedBytes: 40 }],
  load: [0, 0, 0],
  memoryTotalBytes: 100,
  memoryUsedBytes: 1,
  t,
  uptimeSeconds: 100,
});

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

// The Disks card's heading for a sample taken at `t`.
const heading = (t: number) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <SystemDisks
        detail={{
          conditions: [],
          diskTrends: [],
          latest: latest(t),
          limitPercent: undefined,
          now: NOW,
        }}
      />,
    ),
  );
  const text = container.querySelector('h2')?.textContent ?? '';
  flushSync(() => root.unmount());
  container.remove();
  return text;
};

try {
  const old = heading(NOW - 2 * HOUR);
  assert(old.startsWith('Disks, as of '), `An old sample's disks are dated, not "${old}"`);
  const current = heading(NOW - 60_000);
  assert(
    current === 'Disks growth over 7 days',
    `A current sample's disks are not dated, not "${current}"`,
  );
  document.body.textContent = 'System disks DOM tests passed';
} catch (error) {
  document.body.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
