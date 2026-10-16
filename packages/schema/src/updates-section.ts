import { z } from 'zod';

import { FUTURE_SAMPLE_TOLERANCE_MS } from './conditions.ts';
import { epochMs, storableText } from './values.ts';

export const MAX_UPDATES_SECTION_BYTES = 1024 * 1024;
export const UPDATE_OBSERVATION_MAX_AGE_MS = 86400000;
export const UPDATE_METADATA_MAX_AGE_MS = 7 * 86400000;
export const freshUpdateTime = (at: number, now: number, maxAge = UPDATE_OBSERVATION_MAX_AGE_MS) =>
  at <= now + FUTURE_SAMPLE_TOLERANCE_MS && now - at <= maxAge;
const name = z
  .string()
  .min(1)
  .max(512)
  .transform(storableText)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 512);
const uniqueNames = z
  .array(name)
  .max(20000)
  .refine((names) => new Set(names).size === names.length);
const unavailable = z.object({
  kind: z.literal('unavailable'),
  reason: z.string().min(1).max(1024),
});

export const PendingUpdateSchema = z.object({
  available: name.nullable(),
  installed: name.nullable(),
  name,
  security: z.boolean().nullable(),
});
const pendingUpdates = z
  .array(PendingUpdateSchema)
  .max(20000)
  .refine((updates) => new Set(updates.map((update) => update.name)).size === updates.length);
const available = z.object({
  kind: z.literal('available'),
  metadataAt: epochMs.nullable(),
  updates: pendingUpdates,
});
const installedVersion = z.object({ name, version: name });
const installedVersions = z
  .array(installedVersion)
  .max(20000)
  .refine((versions) => new Set(versions.map((entry) => entry.name)).size === versions.length);
const installedCensus = z
  .object({
    names: uniqueNames,
    observedAt: epochMs,
    // Only fully installed versions establish candidate installation. Partial
    // installation states stay present in names without a confirmed version.
    versions: installedVersions.optional(),
  })
  .refine((census) => {
    const names = new Set(census.names);
    return census.versions?.every((entry) => names.has(entry.name)) ?? true;
  });
export const UpdateManagerSchema = z.object({
  installation: name,
  installed: installedCensus.optional(),
  manager: z.enum(['apt', 'homebrew', 'macos']),
  observedAt: epochMs,
  result: z.discriminatedUnion('kind', [available, unavailable]),
});
export const RebootObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), observedAt: epochMs, required: z.boolean() }),
  unavailable.extend({ observedAt: epochMs }),
]);
export const UpdatesSectionSchema = z
  .object({
    managers: z
      .array(UpdateManagerSchema)
      .max(16)
      .refine(
        (managers) =>
          new Set(
            managers.map(({ manager, installation }) => JSON.stringify([manager, installation])),
          ).size === managers.length,
      ),
    reboot: RebootObservationSchema,
  })
  .refine(
    (section) =>
      new TextEncoder().encode(JSON.stringify(section)).byteLength <= MAX_UPDATES_SECTION_BYTES,
  );

export type PendingUpdate = z.infer<typeof PendingUpdateSchema>;
export type UpdateManager = z.infer<typeof UpdateManagerSchema>;
export type RebootObservation = z.infer<typeof RebootObservationSchema>;
export type UpdatesSection = z.infer<typeof UpdatesSectionSchema>;

export const updateSubject = (
  manager: Pick<UpdateManager, 'manager' | 'installation'>,
  packageName: string,
) =>
  JSON.stringify([manager.manager, storableText(manager.installation), storableText(packageName)]);
