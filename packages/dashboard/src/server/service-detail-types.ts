// The data a Service page renders: one Service of one System, with what its
// provisioner recorded, the checks on it, the open Service restarted note, its
// Service stops, and its Service down raises and clears. Times are epoch
// milliseconds, except the stops', which are the ISO times the Hub's read gives.

import type { ServiceStopsRead } from '@heimdall/schema';

import type { Install } from '../lib/service-installs.ts';
import type { ServiceUpdate, UpstreamRelease } from '../lib/service-updates.ts';
import type { RecordedService } from './system-detail-types.ts';
import type { VitalsWindow } from './vitals-window-types.ts';

export type ServiceStop = ServiceStopsRead['stops'][number];

// A Service down Condition of the Service being raised or cleared.
export type ServiceDownTransition = {
  at: number;
  // The Condition's id, for its page.
  condition: string;
  kind: 'cleared' | 'raised';
  reason: string;
};

export type ServiceDetail = {
  // The raises and clears of each Service down open in the 90 days before
  // `now`, its raise however old, in the order the Hub recorded them.
  downs: ServiceDownTransition[];
  // The installed version and upstream the Hub derived, null while unknown. An
  // Application the Service record names that the System has not recorded is
  // named by `missingApplication`.
  installed: {
    missingApplication: string | undefined;
    upstream: string | null;
    version: string | null;
  };
  // The changes between known installed versions in the 90 days before `now`, newest first.
  installs: Install[];
  update: ServiceUpdate;
  updates: UpstreamRelease[];
  now: number;
  // The open Service restarted note for this Service, if any.
  note: { id: string; raisedAt: number; reason: string } | undefined;
  // The Service's record and checks, undefined once its provisioner forgot it.
  recorded: RecordedService | undefined;
  // The spans in which the System sent Vitals from a day before the 90 days
  // before `now`, oldest first, for the strip to bin into the viewer's days.
  reported: { from: number; to: number }[];
  // The selected stop and the System's Vitals around it; undefined when the
  // Service has no stop.
  selection: { span: { from: number; to: number }; vitals: VitalsWindow } | undefined;
  service: string;
  // The stops in the 90 days before `now`, newest first.
  stops: ServiceStop[];
  system: string;
  // Where the record puts the Service under its supervisor: unit, container, or label.
  unit: string | undefined;
};
