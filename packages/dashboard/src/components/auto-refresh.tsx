import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import { keepRefreshing } from '../lib/refresh.ts';
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

// Reads the page's data again every 15 seconds while the tab is visible,
// through the router, so the page keeps its place and state.
export function AutoRefresh() {
  const router = useRouter();
  useEffect(
    () =>
      keepRefreshing(() => {
        void router.invalidate();
      }, browser),
    [router],
  );
  return null;
}
