import { z } from 'zod';

// Names of Fleet's Applications, Services, Backup Jobs, and Harnesses: Fleet's
// DNS-label pattern without the length cap System names carry.
export const unitName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
// The patterns Fleet validates repositories and release tags with.
export const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
export const releaseTag = z.string().regex(/^v?[0-9A-Za-z][0-9A-Za-z._-]*$/u);
export const retentionDays = z.int().min(1).max(3650);

// True when no two items share a key. JSON Schema states uniqueness only for
// whole items, so for keyed items only Heimdall checks it.
export const isUnique = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;

// One time of day a Backup Job runs, in its System's local time.
export const scheduledTime = {
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
};

// The times a Backup Job runs each day. The Inventory refuses unknown fields
// and records drop them (ADR-0010), so each passes its own kind of object.
export const scheduleOf = <T extends { hour: number; minute: number }>(time: z.ZodType<T>) =>
  z
    .array(time)
    .min(1)
    .refine((times) => isUnique(times, ({ hour, minute }) => `${hour}:${minute}`), {
      message: 'scheduled times repeat',
    })
    .meta({ uniqueItems: true });
