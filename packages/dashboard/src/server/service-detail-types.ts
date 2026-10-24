// The data a Service page renders: one Service of one System, with what its
// provisioner recorded, the checks on it, the open Service restarted note, and
// its Service stops. Times are epoch milliseconds, except the stops', which are
// the ISO times the Hub's read gives.

import type { ServiceStopsRead } from '@heimdall/schema';

import type { RecordedService } from './system-detail-types.ts';

export type ServiceStop = ServiceStopsRead['stops'][number];

export type ServiceDetail = {
  now: number;
  // The open Service restarted note for this Service, if any.
  note: { id: string; raisedAt: number; reason: string } | undefined;
  // The Service's record and checks, undefined once its provisioner forgot it.
  recorded: RecordedService | undefined;
  service: string;
  // The stops in the 90 days before `now`, newest first.
  stops: ServiceStop[];
  system: string;
  // Where the record puts the Service under its supervisor: unit, container, or label.
  unit: string | undefined;
};
