import { UpdateManagerSchema } from '@heimdall/schema';

import type { UpstreamCheck } from '../lib/service-updates.ts';

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

export const upstreamCheckOf = (row: UpstreamCheckRow | undefined): UpstreamCheck | undefined =>
  row === undefined || row.checked_at === null
    ? undefined
    : {
        checkedAt: row.checked_at.getTime(),
        failure: row.failure,
        releases: row.releases,
        succeededAt: row.succeeded_at?.getTime() ?? null,
      };
