import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VitalsSample } from '@heimdall/schema';

// One sample as a Collector on macOS would take it, at time `t`.
export const sample = (t: number): VitalsSample => ({
  collector: { cpuPercent: 0.4, rssBytes: 41_943_040 },
  cpu: { busyPercent: 23.4 },
  disks: [
    { mount: '/System/Volumes/Data', totalBytes: 994_662_584_320, usedBytes: 412_316_860_416 },
  ],
  load: [1.2, 0.9, 0.7],
  memory: { totalBytes: 34_359_738_368, usedBytes: 12_884_901_888 },
  t,
  uptimeSeconds: 86_400,
});

// A fresh state directory that removes itself when disposed: `await using dir = await tempStateDir()`.
export const tempStateDir = async () => {
  const path = await mkdtemp(join(tmpdir(), 'heimdall-collector-'));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { force: true, recursive: true }),
  };
};
