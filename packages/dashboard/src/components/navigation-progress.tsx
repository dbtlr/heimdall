import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { isNavigating, trackNavigation } from '../lib/navigation-progress.ts';
import type { NavigationHost, NavigationPhase } from '../lib/navigation-progress.ts';
import { cn } from '../lib/utils.ts';

const browser: NavigationHost = {
  after: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

// The phase of the wait for the page the location has moved to.
const useNavigationPhase = (): NavigationPhase => {
  const navigating = useRouterState({ select: isNavigating });
  const [phase, setPhase] = useState<NavigationPhase>('idle');
  const tracker = useRef<ReturnType<typeof trackNavigation> | undefined>(undefined);
  useEffect(() => {
    const started = trackNavigation(setPhase, browser);
    tracker.current = started;
    return () => {
      started.stop();
      tracker.current = undefined;
    };
  }, []);
  useEffect(() => {
    tracker.current?.update(navigating);
  }, [navigating]);
  return phase;
};

// The line creeps towards the end without reaching it, since no read says how
// far along it is; arrival runs it to the end and fades it. Without motion it
// stands still, most of the way across.
const LINE: Record<NavigationPhase, string> = {
  done: 'scale-x-100 opacity-0 transition-[scale,opacity] duration-200 [transition-delay:0ms,200ms] motion-reduce:transition-none',
  idle: 'scale-x-0 opacity-0',
  loading:
    'scale-x-[0.94] opacity-100 transition-[scale] duration-[9s] ease-[cubic-bezier(0.1,0.9,0.7,0.9)] motion-reduce:transition-none',
};

// Wraps the page: while the next page takes a while to arrive, from any link,
// the jump box, back and forward, or a range picker, a line runs along the top
// edge and the page being left dims and takes no taps. The background refresh
// of the page in view shows neither.
export function NavigationProgress({ children }: { children: ReactNode }) {
  const phase = useNavigationPhase();
  const loading = phase === 'loading';
  return (
    <>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 h-[3px] origin-left bg-primary shadow-[0_0_10px_var(--primary)]',
          LINE[phase],
        )}
        data-navigation-line={phase}
      />
      <div
        aria-busy={loading}
        className={cn(
          'transition-opacity duration-200 motion-reduce:transition-none',
          loading && 'pointer-events-none opacity-40',
        )}
      >
        {children}
      </div>
    </>
  );
}
