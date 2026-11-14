import { PendingUpdateSchema, UpdateManagerSchema } from '@heimdall/schema';

import type { UpstreamCheck } from '../lib/service-updates.ts';
import type { PendingPackage } from './condition-detail-types.ts';

export type UpstreamCheckRow = {
  checked_at: Date | null;
  failure: string | null;
  releases: UpstreamCheck['releases'];
  succeeded_at: Date | null;
};

export const parseUpdateObservations = (observations: readonly unknown[]) =>
  observations.flatMap((observation) => {
    const parsed = UpdateManagerSchema.safeParse(observation);
    return parsed.success ? [parsed.data] : [];
  });

// One update_subjects row as a pending package. A stored pending update that
// no longer parses keeps the package listed, its versions and whether it is a
// security update unknown, so one bad row cannot hide the rest.
export const pendingPackageOf = (row: {
  name: string;
  pending_update: unknown;
  security_since: Date | null;
}): PendingPackage => {
  const parsed = PendingUpdateSchema.safeParse(row.pending_update);
  const { available, installed, security } = parsed.success
    ? parsed.data
    : { available: null, installed: null, security: null };
  return {
    available,
    installed,
    name: row.name,
    security,
    securitySince: row.security_since?.getTime() ?? null,
  };
};

export const upstreamCheckOf = (row: UpstreamCheckRow | undefined): UpstreamCheck | undefined =>
  row === undefined || row.checked_at === null
    ? undefined
    : {
        checkedAt: row.checked_at.getTime(),
        failure: row.failure,
        releases: row.releases,
        succeededAt: row.succeeded_at?.getTime() ?? null,
      };
