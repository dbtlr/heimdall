import { z } from 'zod';

import { releaseTag, retentionDays, scheduledTime, scheduleOf, unitName } from './fleet.ts';
import { versionedParser } from './versioned.ts';

// The install record schema version this build reads. Bump it only for a
// rename, a removal, or a change of meaning; new optional fields keep it.
export const INSTALL_RECORD_SCHEMA_VERSION = 1;

// What every install record carries: what Fleet installed, from which commit
// of its repository, and when. A commit Fleet ran from a dirty tree carries
// Fleet's `-dirty` suffix.
const installed = {
  commit: z.string().regex(/^[0-9a-f]{40}(?:-dirty)?$/u),
  installedAt: z.iso.datetime(),
  name: unitName,
  schemaVersion: z.literal(INSTALL_RECORD_SCHEMA_VERSION),
};

const ApplicationInstallSchema = z.object({
  ...installed,
  kind: z.literal('application'),
  // The release tag Fleet installed, or null when Fleet did not resolve one.
  release: releaseTag.nullable(),
});

// A health URL the Collector may request: plain HTTP to the IPv4 loopback
// address with an explicit port, which Fleet already requires of every health
// URL. Nothing may follow the port but a path, so no user part can hide
// another host.
const loopbackUrl = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?:\/\S*)?$/u)
  .refine((url) => Number(/^http:\/\/127\.0\.0\.1:([0-9]+)/u.exec(url)?.[1]) <= 65_535, {
    message: 'health URL port out of range',
  });

// A Service as Fleet installed it. Fleet renders a `systemd` Service's system
// unit and a `docker` Service's container; a `native` Service's Application
// writes and names its own unit, so Fleet records neither.
const service = {
  ...installed,
  // The loopback URL Fleet polls for health, when the Service declares one.
  healthUrl: loopbackUrl.optional(),
  kind: z.literal('service'),
  // The port the Service listens on, when the Service declares ingress.
  port: z.int().min(1).max(65_535).optional(),
};

const ServiceInstallSchema = z.discriminatedUnion('supervisor', [
  z.object({
    ...service,
    supervisor: z.literal('systemd'),
    unit: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.service$/u),
  }),
  z.object({
    ...service,
    container: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
    supervisor: z.literal('docker'),
  }),
  z.object({ ...service, supervisor: z.literal('native') }),
]);

// A Backup Job as Fleet installed it. Fleet runs Backup Jobs only as launchd
// agents today; the supervisor names the scheduler so another can join.
const BackupJobInstallSchema = z.object({
  ...installed,
  // The directory the Backup Job writes its archives to.
  destination: z.string().regex(/^\/./u),
  kind: z.literal('backup-job'),
  label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  retentionDays,
  schedule: scheduleOf(z.object(scheduledTime)),
  supervisor: z.literal('launchd'),
});

// The record Fleet leaves on a System for each Application, Service, or Backup
// Job it installs there (ADR-0010). Readers drop fields they do not know, so a
// new optional field reaches older Collectors without breaking them.
export const InstallRecordSchema = z
  .discriminatedUnion('kind', [
    ApplicationInstallSchema,
    ServiceInstallSchema,
    BackupJobInstallSchema,
  ])
  .meta({
    description:
      'The record Fleet leaves on a System for each Application, Service, or Backup Job it installs there (ADR-0010). Beyond this schema, Heimdall refuses a health URL port above 65535 and a Backup Job scheduled twice at one time. Fleet writes no field this schema does not name; a Collector reading a newer version of it drops the fields it does not know.',
    title: `Heimdall install record v${String(INSTALL_RECORD_SCHEMA_VERSION)}`,
  });

export type InstallRecord = z.infer<typeof InstallRecordSchema>;

export const parseInstallRecord = versionedParser(
  InstallRecordSchema,
  INSTALL_RECORD_SCHEMA_VERSION,
);
