import { z } from 'zod';

import { RECORD_NAME } from './records.ts';
import { epochMs } from './values.ts';

// The most Service stops one Report carries. A stop comes to about 200 bytes of
// JSON, so a full section is about 200 KB; the rest of a longer log rides the
// next Reports.
export const MAX_SERVICE_STOPS_PER_REPORT = 1000;

// One Service stop, as the Collector logs it from the supervisor's own facts
// (ADR-0021). `stoppedAt` is when the supervisor shows the Service left its
// running state, and keys the stop with the Service. `startedAt` is when it ran
// again, null while `ongoing` says it has not, and null too when the Collector
// lost sight of the end, as across a reboot. `restarts` is how many automatic
// restarts the supervisor counted during the stop. `result` and `exitStatus`
// are the supervisor's word for how the run ended and the main process's exit
// status, null when the Collector never saw the Service stopped, since systemd
// forgets both when the Service starts again. The result is any short word, so
// one only a newer supervisor knows does not reject a Report (ADR-0004). A stop
// still under way is sent again once it ends, with the same `stoppedAt`.
const SentServiceStopSchema = z.object({
  exitStatus: z.int32().nullable(),
  ongoing: z.boolean(),
  restarts: z.int32().nonnegative(),
  result: z.string().min(1).max(64).nullable(),
  service: z.string().regex(RECORD_NAME),
  startedAt: epochMs.nullable(),
  stoppedAt: epochMs,
});

// A Report's Service stops section: the stops the Collector logged that the Hub
// has not yet taken, oldest first. A Collector sends it while it holds any, and
// drops each stop once a Report carrying it is delivered.
export const ServiceStopsSectionSchema = z.object({
  stops: z
    .array(SentServiceStopSchema)
    .max(MAX_SERVICE_STOPS_PER_REPORT)
    .refine(
      (stops) =>
        new Set(stops.map(({ service, stoppedAt }) => JSON.stringify([service, stoppedAt])))
          .size === stops.length,
      { message: 'duplicate Service stop' },
    ),
});

export type ServiceStopsSection = z.infer<typeof ServiceStopsSectionSchema>;
export type SentServiceStop = z.infer<typeof SentServiceStopSchema>;
