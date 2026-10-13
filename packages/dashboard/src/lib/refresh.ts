// How often the pages read their data again.
export const REFRESH_EVERY_MS = 15_000;

// What refreshing needs from the page: whether it is hidden, a call to tell
// when that changes, and a repeating timer. The browser supplies them in the
// app; a test supplies its own.
export type RefreshHost = {
  // Calls `tick` every `everyMs` until the returned function cancels it.
  repeat: (tick: () => void, everyMs: number) => () => void;
  isHidden: () => boolean;
  // Calls `listener` whenever the page is hidden or shown; the returned function stops it.
  onVisibilityChange: (listener: () => void) => () => void;
};

// Calls `refresh` every `everyMs` while the page is visible. A hidden page
// pauses it, and showing the page refreshes at once and starts the period
// over, so a returning reader never sees old data. A tick, or a showing, that
// finds the previous load still `isPending` is skipped, so a slow load is never
// cut off and started again. Returns a function that stops it all.
export const keepRefreshing = (
  refresh: () => void,
  host: RefreshHost,
  { everyMs = REFRESH_EVERY_MS, isPending }: { everyMs?: number; isPending: () => boolean },
): (() => void) => {
  const refreshUnlessPending = () => {
    if (!isPending()) {
      refresh();
    }
  };
  let cancel: (() => void) | undefined;
  const pause = () => {
    cancel?.();
    cancel = undefined;
  };
  const resume = () => {
    cancel ??= host.repeat(refreshUnlessPending, everyMs);
  };
  const stopListening = host.onVisibilityChange(() => {
    if (host.isHidden()) {
      pause();
    } else if (cancel === undefined) {
      refreshUnlessPending();
      resume();
    }
  });
  if (!host.isHidden()) {
    resume();
  }
  return () => {
    stopListening();
    pause();
  };
};
