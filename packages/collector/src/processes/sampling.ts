import type { VitalsSample } from '@heimdall/schema';

import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import type { Sampler } from '../vitals/sampler.ts';
import { createProcessObserver } from './observation.ts';
import type { ProcessSamplingReader } from './table.ts';
import { createProcessTracker } from './tracker.ts';

// One table pass supplies both views. Process failures leave good host Vitals
// intact and discard the delta baseline instead of spanning an unseen interval.
export const createProcessSampling = ({
  log,
  monotonicMs,
  now,
  reader,
  sampler,
  uptimeSeconds,
}: {
  log: Log;
  monotonicMs: () => number;
  now: () => number;
  reader: ProcessSamplingReader;
  sampler: Sampler;
  uptimeSeconds: () => number;
}) => {
  const tracker = createProcessTracker({ now, reader });
  const observer = createProcessObserver();
  let failing = false;
  let bootId: string | undefined;
  const readProcesses = async () => {
    const snapshot = await reader.snapshot();
    return { ...snapshot, at: now(), monotonicMs: monotonicMs(), uptimeSeconds: uptimeSeconds() };
  };
  return {
    latest: tracker.latest,
    sample: async (): Promise<VitalsSample> => {
      const [hostResult, tableResult] = await Promise.allSettled([
        sampler.sample(),
        readProcesses(),
      ]);
      if (hostResult.status === 'rejected') {
        observer.reset();
        throw hostResult.reason;
      }
      const sample = hostResult.value;
      try {
        if (tableResult.status === 'rejected') {
          throw tableResult.reason;
        }
        const t = Math.trunc(now());
        await tracker.tick(tableResult.value.entries, t);
        bootId ??= await reader.bootId();
        if (!bootId) {
          throw new Error('The kernel returned no boot identity.');
        }
        const processes = await observer.observe({
          bootId,
          ...tableResult.value,
          nameOf: reader.nameOf,
        });
        failing = false;
        return { ...sample, processes, t };
      } catch (error) {
        observer.reset();
        if (!failing) {
          log.warn(`Could not observe this System's processes: ${describeError(error)}`);
        }
        failing = true;
        return sample;
      }
    },
    settled: tracker.settled,
  };
};
