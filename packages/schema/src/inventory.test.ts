import { describe, expect, test } from 'bun:test';

import { parseInventory } from './inventory.ts';
import type { Application, BackupJob, System } from './inventory.ts';
import { inventory } from './testing.ts';

describe('an Inventory', () => {
  test('parses when complete', () => {
    expect(parseInventory(inventory())).toEqual({ kind: 'parsed', value: inventory() });
  });
});

// The Hub is upgraded before Fleet publishes a new version (ADR-0010), so an
// unknown version means the Hub is behind, not that the Inventory is broken.
describe('an Inventory of an unknown schema version', () => {
  test('is refused as unknown even when its shape differs', () => {
    expect(parseInventory({ schemaVersion: 2, systems: {} })).toEqual({
      kind: 'unknown-version',
      schemaVersion: 2,
    });
  });

  test.each([
    ['missing', undefined],
    ['fractional', 1.5],
    ['a string', '1'],
    ['zero', 0],
    ['negative', -3],
  ])('is invalid when its version is %s', (_, schemaVersion) => {
    expect(parseInventory({ ...inventory(), schemaVersion }).kind).toBe('invalid');
  });

  test('is not claimed by a known version with an unknown shape', () => {
    expect(parseInventory({ schemaVersion: 1, systems: {} }).kind).toBe('invalid');
  });
});

const withSystems = (...systems: object[]) => ({ ...inventory(), systems });

describe('an Inventory is invalid', () => {
  const [laptop, server] = inventory().systems as [System, System];
  const withLaptop = (override: object) => withSystems({ ...laptop, ...override }, server);
  const [collector] = laptop.applications as [Application];
  const [notes] = laptop.backupJobs as [BackupJob];

  test.each([
    // Unknown fields are refused, not dropped: a misspelled optional field
    // would otherwise read as nothing declared (ADR-0010).
    ['with a field the Hub does not know', { ...inventory(), publishedAt: 1_759_700_000_000 }],
    ['with a System field the Hub does not know', withLaptop({ center: true })],
    [
      'with an Application field the Hub does not know',
      withLaptop({ applications: [{ ...collector, installScript: 'install.sh' }] }),
    ],
    [
      'with a Service field the Hub does not know',
      withLaptop({ services: [{ name: 'notes', port: 8080, supervisor: 'systemd' }] }),
    ],
    [
      'with a Backup Job field the Hub does not know',
      withLaptop({ backupJobs: [{ ...notes, volume: '/Volumes/Backups' }] }),
    ],
    [
      'with a scheduled time field the Hub does not know',
      withLaptop({ backupJobs: [{ ...notes, schedule: [{ hour: 3, minute: 15, second: 0 }] }] }),
    ],
    [
      'with a database field the Hub does not know',
      {
        ...inventory(),
        databases: [{ extensions: [], name: 'heimdall', role: 'heimdall', system: 'server-1' }],
      },
    ],
    ['with no Systems', { ...inventory(), databases: [], systems: [] }],
    ['with an abbreviated commit', { ...inventory(), commit: '3f1c2a9' }],
    ['with a dirty commit', { ...inventory(), commit: `${inventory().commit}-dirty` }],
    ['naming a System outside Fleet names', withLaptop({ name: 'Laptop_1' })],
    ['with an OS Fleet does not declare', withLaptop({ os: 'windows' })],
    ['with an empty tag', withLaptop({ tags: [''] })],
    ['with a Harness outside Fleet names', withLaptop({ harnesses: ['Claude Code'] })],
    [
      'with a channel Fleet does not declare',
      withLaptop({ applications: [{ ...collector, channel: 'main' }] }),
    ],
    [
      'with an Application not yet resolved to a release',
      withLaptop({ applications: [{ ...collector, release: '' }] }),
    ],
    [
      'with a repository that is not owner/name',
      withLaptop({ applications: [{ ...collector, repository: 'heimdall' }] }),
    ],
    [
      'with a supervisor Fleet does not declare',
      withLaptop({ services: [{ name: 'notes', supervisor: 'launchd' }] }),
    ],
    ['with a Backup Job that never runs', withLaptop({ backupJobs: [{ ...notes, schedule: [] }] })],
    [
      'with a Backup Job at hour 24',
      withLaptop({ backupJobs: [{ ...notes, schedule: [{ hour: 24, minute: 0 }] }] }),
    ],
    [
      'with a Backup Job that keeps nothing',
      withLaptop({ backupJobs: [{ ...notes, retentionDays: 0 }] }),
    ],
    [
      'with a database named outside PostgreSQL identifiers',
      { ...inventory(), databases: [{ name: 'Heimdall', role: 'heimdall', system: 'server-1' }] },
    ],
    // Fleet's own rules, which JSON Schema cannot state.
    ['naming a System twice', withSystems(laptop, server, laptop)],
    [
      'naming an Application twice on one System',
      withLaptop({ applications: [collector, collector] }),
    ],
    [
      'naming a Service twice on one System',
      withLaptop({
        services: [
          { name: 'notes', supervisor: 'systemd' },
          { name: 'notes', supervisor: 'docker' },
        ],
      }),
    ],
    ['naming a Backup Job twice on one System', withLaptop({ backupJobs: [notes, notes] })],
    ['naming a Harness twice on one System', withLaptop({ harnesses: ['codex', 'codex'] })],
    [
      'scheduling a Backup Job twice at one time',
      withLaptop({
        backupJobs: [
          {
            ...notes,
            schedule: [
              { hour: 3, minute: 15 },
              { hour: 3, minute: 15 },
            ],
          },
        ],
      }),
    ],
    [
      'hosting a database on a System it does not declare',
      { ...inventory(), databases: [{ name: 'notes', role: 'notes', system: 'server-2' }] },
    ],
    [
      'naming a database twice on one System',
      {
        ...inventory(),
        databases: [
          { name: 'heimdall', role: 'heimdall', system: 'server-1' },
          { name: 'heimdall', role: 'heimdall_reader', system: 'server-1' },
        ],
      },
    ],
    [
      'naming a database role twice on one System',
      {
        ...inventory(),
        databases: [
          { name: 'heimdall', role: 'heimdall', system: 'server-1' },
          { name: 'notes', role: 'heimdall', system: 'server-1' },
        ],
      },
    ],
  ])('%s', (_, input) => {
    expect(parseInventory(input).kind).toBe('invalid');
  });
});

// The cross-reference check would otherwise blame the database for a System
// that failed on its own.
test('an Inventory with a misnamed System is not also blamed for its databases', () => {
  const [laptop, server] = inventory().systems as [System, System];
  const parsed = parseInventory(withSystems(laptop, { ...server, name: 'Server_1' }));

  expect(parsed.kind === 'invalid' && parsed.reason).not.toContain('does not declare');
});

describe('an Inventory may', () => {
  test('host the same database name on two Systems', () => {
    const databases = [
      { name: 'heimdall', role: 'heimdall', system: 'server-1' },
      { name: 'heimdall', role: 'heimdall', system: 'laptop-1' },
    ];

    expect(parseInventory({ ...inventory(), databases }).kind).toBe('parsed');
  });
});
