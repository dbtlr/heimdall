import type { RefreshHost } from './refresh.ts';

// How often a visible page asks the server which build it serves.
export const UPDATE_CHECK_EVERY_MS = 60_000;

// The shortest time between two reloads for a missing chunk.
export const CHUNK_RELOAD_GAP_MS = 60_000;

// A dashboard build: its release version and the id its build was given, which
// differs between any two builds of the same version.
export type RunningBuild = { build: string; version: string };

// What the page knows about the server's build: not asked yet, the one this
// page runs, or a different one it can load.
export type UpdateState =
  | { kind: 'unknown' }
  | { kind: 'current' }
  | ({ kind: 'ready' } & RunningBuild);

// What watching needs beyond refreshing's visibility and timer: a read of the
// server's build, undefined when the server did not answer, and a reload.
export type UpdateHost = RefreshHost & {
  readBuild: () => Promise<RunningBuild | undefined>;
  reload: () => void;
};

// Watches for the server serving a build other than `running`, which a phone
// can keep running for days from its home screen. A visible page asks at once
// and then every `everyMs`, and hands a different build to `onChange` as ready
// to load, once per build, so the reader chooses when to reload. A page shown
// again after being hidden asks at once and reloads itself on a different
// build, since the reader is only now coming back to it. A server that does not
// answer changes nothing. Returns a function that stops it all.
export const watchForUpdates = (
  running: RunningBuild,
  host: UpdateHost,
  onChange: (state: UpdateState) => void,
  { everyMs = UPDATE_CHECK_EVERY_MS }: { everyMs?: number } = {},
): (() => void) => {
  let stopped = false;
  let checking = false;
  // Set when the page is shown while a check is out, so that check's answer
  // reloads as a check made on showing would.
  let shownSinceCheck = false;
  let offered: string | undefined;
  let cancel: (() => void) | undefined;

  const check = async (shown: boolean) => {
    shownSinceCheck ||= shown;
    if (checking) {
      return;
    }
    checking = true;
    const answer = await host.readBuild().catch(() => undefined);
    checking = false;
    const reloads = shownSinceCheck;
    shownSinceCheck = false;
    if (stopped || answer === undefined) {
      return;
    }
    if (answer.build === running.build) {
      onChange({ kind: 'current' });
    } else if (reloads) {
      host.reload();
    } else if (offered !== answer.build) {
      offered = answer.build;
      onChange({ build: answer.build, kind: 'ready', version: answer.version });
    }
  };

  const pause = () => {
    cancel?.();
    cancel = undefined;
  };
  const resume = () => {
    cancel ??= host.repeat(() => void check(false), everyMs);
  };
  const stopListening = host.onVisibilityChange(() => {
    if (host.isHidden()) {
      pause();
    } else if (cancel === undefined) {
      void check(true);
      resume();
    }
  });
  if (!host.isHidden()) {
    void check(false);
    resume();
  }
  return () => {
    stopped = true;
    stopListening();
    pause();
  };
};

// Whether a failed load of a script chunk, which a new build's renamed files
// cause in a page still running the old one, should reload the page: yes,
// unless it reloaded for one in the last minute, so a chunk that stays missing
// cannot reload the page over and over.
export const reloadsForMissingChunk = (lastReloadAt: number | undefined, now: number): boolean =>
  lastReloadAt === undefined || now - lastReloadAt >= CHUNK_RELOAD_GAP_MS;
