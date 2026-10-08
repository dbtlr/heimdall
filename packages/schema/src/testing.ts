import type { Inventory } from './inventory.ts';
import type { VitalsSample } from './report.ts';

// An Inventory of two Systems: a desktop Mac that backs up a notes database,
// and a server that hosts the Hub and its database.
export const inventory = (): Inventory => ({
  commit: '3f1c2a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
  databases: [{ name: 'heimdall', role: 'heimdall', system: 'server-1' }],
  schemaVersion: 1,
  systems: [
    {
      applications: [
        {
          channel: 'stable',
          name: 'heimdall-collector',
          release: 'v0.2.0',
          repository: 'dbtlr/heimdall',
        },
      ],
      backupJobs: [
        {
          name: 'notes',
          retentionDays: 30,
          schedule: [
            { hour: 3, minute: 15 },
            { hour: 15, minute: 15 },
          ],
        },
      ],
      harnesses: ['claude-code', 'codex'],
      name: 'laptop-1',
      os: 'darwin',
      services: [],
      tags: ['desktop', 'dev'],
    },
    {
      applications: [
        { channel: 'stable', name: 'heimdall', release: 'v0.2.0', repository: 'dbtlr/heimdall' },
        {
          channel: 'next',
          name: 'heimdall-collector',
          release: 'v0.3.0-rc.1',
          repository: 'dbtlr/heimdall',
        },
      ],
      backupJobs: [],
      harnesses: [],
      name: 'server-1',
      os: 'linux',
      services: [
        { name: 'heimdall', supervisor: 'native' },
        { name: 'heimdall-collector', supervisor: 'native' },
      ],
      tags: ['server', 'headless'],
    },
  ],
});

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
