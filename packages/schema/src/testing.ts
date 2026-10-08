import type { InstallRecord } from './install-record.ts';
import type { Inventory } from './inventory.ts';
import type { VitalsSample } from './report.ts';
import type { RunRecord } from './run-record.ts';

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

// The install record Fleet leaves on laptop-1 after installing the Collector.
export const applicationInstall = (): InstallRecord => ({
  commit: '3f1c2a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
  installedAt: '2026-10-08T03:22:21Z',
  kind: 'application',
  name: 'heimdall-collector',
  release: 'v0.2.0',
  schemaVersion: 1,
});

// The install record Fleet leaves on server-1 after installing a systemd
// Service with a loopback health check.
export const serviceInstall = (): InstallRecord => ({
  commit: '3f1c2a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
  healthUrl: 'http://127.0.0.1:8080/api/health',
  installedAt: '2026-10-08T03:22:21Z',
  kind: 'service',
  name: 'notes',
  port: 8080,
  schemaVersion: 1,
  supervisor: 'systemd',
  unit: 'notes.service',
});

// The install record Fleet leaves on laptop-1 after installing the notes
// Backup Job as a launchd agent.
export const backupJobInstall = (): InstallRecord => ({
  commit: '3f1c2a9d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
  destination: '/Volumes/Backups/notes',
  installedAt: '2026-10-08T03:22:21Z',
  kind: 'backup-job',
  label: 'com.example.fleet.backup.notes',
  name: 'notes',
  retentionDays: 30,
  schedule: [
    { hour: 3, minute: 15 },
    { hour: 15, minute: 15 },
  ],
  schemaVersion: 1,
  supervisor: 'launchd',
});

// The notes Backup Job's run record after its afternoon run failed because
// its volume was not mounted, following a successful morning run.
export const runRecord = (): RunRecord => ({
  latestRun: {
    archive: null,
    exitStatus: 1,
    finishedAt: '2026-10-08T19:15:01Z',
    startedAt: '2026-10-08T19:15:00Z',
  },
  latestSuccess: {
    archive: { name: '2026-10-08T071500Z.sqlite', sizeBytes: 5_242_880 },
    exitStatus: 0,
    finishedAt: '2026-10-08T07:15:04Z',
    startedAt: '2026-10-08T07:15:00Z',
  },
  name: 'notes',
  schemaVersion: 1,
});
