import { z } from 'zod';

import {
  isUnique,
  releaseTag,
  repository,
  retentionDays,
  scheduledTime,
  scheduleOf,
  unitName,
} from './fleet.ts';
import { SYSTEM_NAME } from './report.ts';
import { versionedParser } from './versioned.ts';

// The Inventory schema version this build speaks. The Hub refuses versions it
// does not know and fields it does not know, so it is upgraded before Fleet
// publishes either. Bump it only for a rename, a removal, or a change of
// meaning; new optional fields keep the version (ADR-0010).
export const INVENTORY_SCHEMA_VERSION = 1;

// The pattern Fleet validates PostgreSQL identifiers with.
const POSTGRES_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

const byName = (item: { name: string }) => item.name;
const uniqueNames = <T extends { name: string }>(schema: z.ZodType<T>, noun: string) =>
  z.array(schema).refine((items) => isUnique(items, byName), { message: `${noun} names repeat` });

const ApplicationSchema = z.strictObject({
  channel: z.enum(['stable', 'next']),
  name: unitName,
  // The tag the channel resolved to when Fleet published the Inventory.
  release: releaseTag,
  repository,
});

const ServiceSchema = z.strictObject({
  name: unitName,
  supervisor: z.enum(['systemd', 'docker', 'native']),
});

const BackupJobSchema = z.strictObject({
  name: unitName,
  retentionDays,
  schedule: scheduleOf(z.strictObject(scheduledTime)),
});

// One System as Fleet declares it, with the Applications, Services, Backup
// Jobs, and Harnesses Fleet's targeting applies to it already resolved.
const SystemSchema = z.strictObject({
  applications: uniqueNames(ApplicationSchema, 'Application'),
  backupJobs: uniqueNames(BackupJobSchema, 'Backup Job'),
  harnesses: z
    .array(unitName)
    .refine((harnesses) => isUnique(harnesses, String), { message: 'Harnesses repeat' })
    .meta({ uniqueItems: true }),
  name: z.string().regex(SYSTEM_NAME),
  os: z.enum(['darwin', 'linux']),
  services: uniqueNames(ServiceSchema, 'Service'),
  tags: z.array(z.string().min(1)),
});

// One database in Fleet's PostgreSQL registry and the System that hosts it.
const DatabaseSchema = z.strictObject({
  name: z.string().regex(POSTGRES_IDENTIFIER),
  role: z.string().regex(POSTGRES_IDENTIFIER),
  system: z.string().regex(SYSTEM_NAME),
});

// The whole-fleet snapshot Fleet publishes to the Hub from one commit of its
// main branch (ADR-0010). It holds what Fleet declares, never commands,
// secrets, or observed state.
export const InventorySchema = z
  .strictObject({
    commit: z.string().regex(COMMIT),
    databases: z
      .array(DatabaseSchema)
      .refine((databases) => isUnique(databases, ({ name, system }) => `${system}/${name}`), {
        message: 'database names repeat on one System',
      })
      .refine((databases) => isUnique(databases, ({ role, system }) => `${system}/${role}`), {
        message: 'database roles repeat on one System',
      }),
    schemaVersion: z.literal(INVENTORY_SCHEMA_VERSION),
    systems: uniqueNames(SystemSchema, 'System').min(1),
  })
  .refine(
    ({ databases, systems }) =>
      databases.every(({ system }) => systems.some(({ name }) => name === system)),
    {
      message: 'a database names a System the Inventory does not declare',
      path: ['databases'],
      // Only a valid list of Systems can show that a database's System is missing.
      when: ({ issues }) => issues.length === 0,
    },
  )
  .meta({
    description:
      "The whole-fleet snapshot Fleet publishes to the Heimdall Hub (ADR-0010). Beyond this schema, the Hub refuses repeated names among Systems and among each System's Applications, Services, and Backup Jobs; a database name or role repeated on one System; and a database on a System the Inventory does not declare.",
    title: `Heimdall Inventory v${String(INVENTORY_SCHEMA_VERSION)}`,
  });

export type Inventory = z.infer<typeof InventorySchema>;
export type System = Inventory['systems'][number];
export type Application = System['applications'][number];
export type BackupJob = System['backupJobs'][number];

export const parseInventory = versionedParser(InventorySchema, INVENTORY_SCHEMA_VERSION);
