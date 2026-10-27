import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import { WIDE_MEDIA } from '../lib/layout.ts';
import { isLoadRunning, keepRefreshing } from '../lib/refresh.ts';
import type { RefreshHost } from '../lib/refresh.ts';

const browser: RefreshHost = {
  isHidden: () => document.hidden,
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => {
      document.removeEventListener('visibilitychange', listener);
    };
  },
  repeat: (tick, everyMs) => {
    const timer = setInterval(tick, everyMs);
    return () => {
      clearInterval(timer);
    };
  },
};

// A Session's data is read once it is shown, and a tick would restart its
// heavy load, so the Session page is left out of the refresh.
const SESSION_ROUTE = '/systems/$name_/sessions/$harness/$source/$sessionId';

// Reads the page's data again every 15 seconds while the tab is visible,
// through the router, so the page keeps its place and state. A tick that finds
// the last load still running waits for the next.
export function AutoRefresh() {
  const router = useRouter();
  useEffect(
    () =>
      keepRefreshing(
        () => {
          void router.invalidate({ filter: (match) => match.routeId !== SESSION_ROUTE });
        },
        browser,
        { isPending: () => isLoadRunning(router.state) },
      ),
    [router],
  );
  return null;
}

// A narrow browser skips the sidebar's read, so widening it past `lg` reads
// the page's data again at once rather than at the next tick.
export function RefreshOnWiden() {
  const router = useRouter();
  useEffect(() => {
    const media = globalThis.matchMedia(WIDE_MEDIA);
    const reread = (event: MediaQueryListEvent) => {
      if (event.matches) {
        void router.invalidate({ filter: (match) => match.routeId !== SESSION_ROUTE });
      }
    };
    media.addEventListener('change', reread);
    return () => {
      media.removeEventListener('change', reread);
    };
  }, [router]);
  return null;
}
