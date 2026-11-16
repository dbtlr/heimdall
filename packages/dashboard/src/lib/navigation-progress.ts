// How long a page may take to arrive before the wait shows. A page that is
// ready sooner changes as if nothing had been waited for.
export const SHOW_AFTER_MS = 150;

// How long the line takes to run to the end and fade once the page arrives.
export const FINISH_MS = 400;

// What the wait for a page shows: nothing, the line creeping over a dimmed
// page, or the line finishing over the page that arrived.
export type NavigationPhase = 'idle' | 'loading' | 'done';

// Whether the router is reading a page the location has moved to and the
// screen has not: a link, the jump box, back and forward, or a search change
// that a page reads by. A refresh of the page in view reads with the location
// where it was, so it is none.
export const isNavigating = ({
  isLoading,
  location,
  resolvedLocation,
}: {
  isLoading: boolean;
  location: { href: string };
  resolvedLocation?: { href: string } | undefined;
}): boolean => isLoading && location.href !== resolvedLocation?.href;

// The timer a tracker needs. The browser supplies it in the app; a test
// supplies its own.
export type NavigationHost = {
  // Calls `run` once after `ms`, unless the returned function cancels it.
  after: (run: () => void, ms: number) => () => void;
};

// Turns "a page is loading" into the phases the wait shows, telling `onPhase`
// of each change. `update` takes whether a page is loading now; `stop` cancels
// what is pending.
export const trackNavigation = (
  onPhase: (phase: NavigationPhase) => void,
  host: NavigationHost,
) => {
  let phase: NavigationPhase = 'idle';
  let navigating = false;
  let cancel: (() => void) | undefined;
  const enter = (next: NavigationPhase) => {
    phase = next;
    onPhase(next);
  };
  const schedule = (next: NavigationPhase, ms: number) => {
    cancel?.();
    cancel = host.after(() => {
      cancel = undefined;
      enter(next);
    }, ms);
  };
  return {
    stop: () => {
      cancel?.();
      cancel = undefined;
    },
    update: (now: boolean) => {
      if (now === navigating) {
        return;
      }
      navigating = now;
      if (navigating) {
        // A line cut off mid-finish goes back to its start, so the next one
        // never runs backwards from the end.
        if (phase === 'done') {
          enter('idle');
        }
        schedule('loading', SHOW_AFTER_MS);
      } else if (phase === 'loading') {
        enter('done');
        schedule('idle', FINISH_MS);
      } else {
        cancel?.();
        cancel = undefined;
      }
    },
  };
};
