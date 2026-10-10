import { SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { SQL } from 'bun';

// How far back the Hub looks for a System's awake time. A span the System was
// not awake for within it has not been awake for, so a Condition that waits on
// awake time is neither raised nor cleared.
const AWAKE_HORIZON_MS = 90 * 24 * 60 * 60_000;

// The most samples a Vitals rollup bucket (ADR-0008) counts as awake time:
// its 5 minutes.
const SAMPLES_PER_BUCKET = (5 * 60_000) / SAMPLE_INTERVAL_MS;

// The start of the latest rollup bucket from which the System was awake for at
// least `graceMs` through its last counted bucket, or undefined when it has not
// been. A span that began at or before it was awake for `graceMs` or more.
export type AwakeCutoff = (graceMs: number) => number | undefined;

type BucketRow = { awake_samples: string; bucket: Date };

// The start of the System's latest rollup bucket, or undefined when it has
// stored no Vitals. It is on the System's own clock, like the samples in it.
export const latestBucketOf = async (tx: SQL, system: string): Promise<number | undefined> => {
  const [row]: { latest: Date | null }[] = await tx`
    SELECT max(bucket) AS latest FROM vitals_rollups WHERE system = ${system}
  `;
  return row?.latest?.getTime();
};

// The System's awake time, from the samples its Collector took every
// SAMPLE_INTERVAL_MS, counted per 5-minute bucket through the bucket starting
// at `through`, for spans up to `maxGraceMs`. A bucket counts as awake for 15
// seconds per sample, up to its whole 5 minutes. A bucket after `through` is
// not counted: a Condition judged against the Hub's clock passes the Hub's now,
// which leaves out a clock running ahead, and one judged on the System's clock
// alone passes its latest bucket. Only the buckets up to the one that completes
// the longest span are read, since no older one is ever a cutoff.
export const awakeCutoffOf = async (
  tx: SQL,
  { maxGraceMs, system, through }: { maxGraceMs: number; system: string; through: number },
): Promise<AwakeCutoff> => {
  const buckets: BucketRow[] = await tx`
    SELECT bucket, awake_samples FROM (
      SELECT bucket, LEAST(samples, ${SAMPLES_PER_BUCKET}) AS counted,
             sum(LEAST(samples, ${SAMPLES_PER_BUCKET})) OVER (ORDER BY bucket DESC) AS awake_samples
      FROM vitals_rollups
      WHERE system = ${system} AND bucket <= ${new Date(through)}
        AND bucket > ${new Date(through - AWAKE_HORIZON_MS)}
    ) b
    WHERE awake_samples - counted < ${Math.ceil(maxGraceMs / SAMPLE_INTERVAL_MS)}
    ORDER BY bucket DESC
  `;
  return (graceMs) =>
    buckets.find((b) => Number(b.awake_samples) * SAMPLE_INTERVAL_MS >= graceMs)?.bucket.getTime();
};
