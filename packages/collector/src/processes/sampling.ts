import { SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { VitalsSample } from '@heimdall/schema';

import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import type { Sampler } from '../vitals/sampler.ts';
import { memoryProcessNames } from './names.ts';
import type { ProcessNameStore } from './names.ts';
import { createProcessObserver } from './observation.ts';
import type { ProcessSamplingReader } from './table.ts';
import { createProcessTracker } from './tracker.ts';

// A stuck host probe must not stop subsequent process ticks. Keep at most one
// host read in flight, and discard its late result after the deadline expires.
const boundedHostRead = (sampler: Sampler, timeoutMs: number) => {
  let pending = false;
  return async (): Promise<VitalsSample> => {
    if (pending) {
      throw new Error('A previous Host Vitals read is still pending.');
    }
    pending = true;
    const result = Promise.withResolvers<VitalsSample>();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      result.reject(new Error(`Host Vitals read exceeded ${String(timeoutMs)} milliseconds.`));
    }, timeoutMs);
    const finish = async () => {
      try {
        const sample = await sampler.sample();
        if (!expired) {
          result.resolve(sample);
        }
      } catch (error) {
        if (!expired) {
          result.reject(error);
        }
      } finally {
        pending = false;
        clearTimeout(timer);
      }
    };
    void finish();
    return result.promise;
  };
};

// One table pass supplies both views. Process failures leave good host Vitals
// intact and discard the delta baseline instead of spanning an unseen interval.
export const createProcessSampling = ({
  hostTimeoutMs = SAMPLE_INTERVAL_MS,
  log,
  monotonicMs,
  names = memoryProcessNames(),
  now,
  reader,
  repositoryOf,
  sampler,
  uptimeSeconds,
}: {
  hostTimeoutMs?: number;
  log: Log;
  monotonicMs: () => number;
  names?: ProcessNameStore;
  now: () => number;
  reader: ProcessSamplingReader;
  repositoryOf?: (cwd: string) => Promise<string | null>;
  sampler: Sampler;
  uptimeSeconds: () => number;
}) => {
  const tracker = createProcessTracker({ now, reader, ...(repositoryOf && { repositoryOf }) });
  const observer = createProcessObserver({ names });
  const readHost = boundedHostRead(sampler, hostTimeoutMs);
  let failing = false;
  let bootId: string | undefined;
  const readProcesses = async () => {
    const snapshot = await reader.snapshot();
    const reading = {
      ...snapshot,
      at: now(),
      monotonicMs: monotonicMs(),
      uptimeSeconds: uptimeSeconds(),
    };
    // Harness visibility follows the table read even when a host probe fails
    // or never settles. Both still consume this single snapshot.
    await tracker.tick(reading.entries, reading.at);
    return reading;
  };
  return {
    latest: tracker.latest,
    sample: async (): Promise<VitalsSample> => {
      const [hostResult, tableResult] = await Promise.allSettled([readHost(), readProcesses()]);
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
