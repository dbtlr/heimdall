import { z } from 'zod';

import { SYSTEM_NAME } from './report.ts';

// The Inventory schema version this build speaks. The Hub refuses versions it
// does not know and fields it does not know, so it is upgraded before Fleet
// publishes either. Bump it only for a rename, a removal, or a change of
// meaning; new optional fields keep the version (ADR-0010).
export const INVENTORY_SCHEMA_VERSION = 1;

// Names of Fleet's Applications, Services, Backup Jobs, and Harnesses: Fleet's
// DNS-label pattern without the length cap System names carry.
const UNIT_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
// The patterns Fleet validates repositories, release tags, and PostgreSQL
// identifiers with.
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_TAG = /^v?[0-9A-Za-z][0-9A-Za-z._-]*$/u;
const POSTGRES_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

const unitName = z.string().regex(UNIT_NAME);

// True when no two items share a key. Fleet enforces these rules on its own
// declarations, and JSON Schema cannot state them, so only the Hub checks them.
const isUnique = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;
const byName = (item: { name: string }) => item.name;
const uniqueNames = <T extends { name: string }>(schema: z.ZodType<T>, noun: string) =>
  z.array(schema).refine((items) => isUnique(items, byName), { message: `${noun} names repeat` });

const ApplicationSchema = z.strictObject({
  channel: z.enum(['stable', 'next']),
  name: unitName,
  // The tag the channel resolved to when Fleet published the Inventory.
  release: z.string().regex(RELEASE_TAG),
  repository: z.string().regex(REPOSITORY),
});

const ServiceSchema = z.strictObject({
  name: unitName,
  supervisor: z.enum(['systemd', 'docker', 'native']),
});

// One time of day a Backup Job runs, in its System's local time.
const ScheduledTimeSchema = z.strictObject({
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
});

const BackupJobSchema = z.strictObject({
  name: unitName,
  retentionDays: z.int().min(1).max(3650),
  schedule: z
    .array(ScheduledTimeSchema)
    .min(1)
    .refine((times) => isUnique(times, ({ hour, minute }) => `${hour}:${minute}`), {
      message: 'scheduled times repeat',
    }),
});

// One System as Fleet declares it, with every Unit Fleet's targeting applies
// to it already resolved.
const SystemSchema = z.strictObject({
  applications: uniqueNames(ApplicationSchema, 'Application'),
  backupJobs: uniqueNames(BackupJobSchema, 'Backup Job'),
  harnesses: z
    .array(unitName)
    .refine((harnesses) => isUnique(harnesses, String), { message: 'Harnesses repeat' }),
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
    { message: 'a database names a System the Inventory does not declare', path: ['databases'] },
  )
  .meta({
    description:
      "The whole-fleet snapshot Fleet publishes to the Heimdall Hub (ADR-0010). Beyond this schema, the Hub refuses repeated names among Systems and among each System's Applications, Services, Backup Jobs, and Harnesses; repeated times in one schedule; a database name or role repeated on one System; and a database on a System the Inventory does not declare.",
    title: `Heimdall Inventory v${String(INVENTORY_SCHEMA_VERSION)}`,
  });

export type Inventory = z.infer<typeof InventorySchema>;
export type System = Inventory['systems'][number];
export type Application = System['applications'][number];
export type BackupJob = System['backupJobs'][number];

// What the Hub makes of a published Inventory. An unknown schema version is
// its own outcome so the Hub can tell Fleet to upgrade the Hub first.
export type InventoryParse =
  | { inventory: Inventory; kind: 'inventory' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unknown-version'; schemaVersion: number };

// The integer schema version an input claims, or undefined when it claims none.
const claimedVersion = (input: unknown) => {
  const version = z.object({ schemaVersion: z.int() }).safeParse(input);
  return version.success ? version.data.schemaVersion : undefined;
};

export const parseInventory = (input: unknown): InventoryParse => {
  const schemaVersion = claimedVersion(input);
  if (schemaVersion !== undefined && schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    return { kind: 'unknown-version', schemaVersion };
  }
  const parsed = InventorySchema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'invalid', reason: z.prettifyError(parsed.error) };
  }
  return { inventory: parsed.data, kind: 'inventory' };
};
