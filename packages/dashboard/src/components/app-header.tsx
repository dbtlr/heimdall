import type { ReactNode } from 'react';

import { contentFrame } from '../lib/layout.ts';
import { cn } from '../lib/utils.ts';
import { AppNavigation } from './app-navigation.tsx';

// The brand and navigation. `inline` sits at the right end of the first row,
// also on a phone; `children` sit at the right end, on a row of their own on a
// phone. From `lg` the sidebar holds the brand, navigation, and Fleet verdict, so
// the header keeps only `children` and is hidden when it has none.
export function AppHeader({ children, inline }: { children?: ReactNode; inline?: ReactNode }) {
  return (
    <header
      className={cn(
        'border-b bg-card pt-[env(safe-area-inset-top)] sm:bg-background',
        children === undefined && 'lg:hidden',
      )}
    >
      <div
        className={cn(
          contentFrame('wide'),
          'flex min-h-[50px] flex-wrap items-center gap-3.5 py-2.5 sm:min-h-0 sm:gap-[22px] sm:py-3',
        )}
      >
        <span className="text-lg font-bold tracking-[0.02em] sm:text-base lg:hidden">Heimdall</span>
        <div className="hidden sm:block lg:hidden">
          <AppNavigation />
        </div>
        {inline !== undefined && (
          <div className="ml-auto flex items-center lg:hidden">{inline}</div>
        )}
        {children !== undefined && (
          <div className="ml-auto flex basis-full justify-end sm:basis-auto">{children}</div>
        )}
      </div>
    </header>
  );
}
