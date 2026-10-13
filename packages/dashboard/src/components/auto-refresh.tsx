import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

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
