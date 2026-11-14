// What the pinned moment on the Activity axis names: the Sessions running at an
// instant, with their cost, and one System's Vitals then. Times are epoch
// milliseconds.

// An agent Session with a stretch running at the instant. `costUsd` is all the
// Session's requests at list price, undefined when any request is unpriced, and
// `startedAt` to `endedAt` is the Session's first request to its latest.
export type MomentSession = {
  costUsd: number | undefined;
  endedAt: number;
  harness: string;
  project: string | undefined;
  sessionId: string;
  source: string;
  startedAt: number;
  system: string;
};

// A System's busy CPU and used memory in percent, and its 1-minute load, at
// `t`: the sample nearest before the instant, or the 5-minute rollup holding it
// when the samples are gone.
export type MomentVitals = {
  cpu: number | undefined;
  load: number | undefined;
  memory: number | undefined;
  t: number;
};

export type PinnedMoment = {
  at: number;
  sessions: MomentSession[];
  system: string | undefined;
  vitals: MomentVitals | undefined;
};
