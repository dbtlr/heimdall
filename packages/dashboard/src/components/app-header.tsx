import type { ReactNode } from 'react';

import { AppNavigation } from './app-navigation.tsx';

// The brand and navigation, with `children` at the right end.
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b bg-card pt-[env(safe-area-inset-top)] sm:bg-background">
      <div className="mx-auto flex min-h-[50px] max-w-[1200px] flex-wrap items-center gap-3.5 px-3.5 py-2.5 sm:min-h-0 sm:gap-[22px] sm:px-[22px] sm:py-3">
        <span className="text-lg font-bold tracking-[0.02em] sm:text-base">Heimdall</span>
        <div className="hidden sm:block">
          <AppNavigation />
        </div>
        {children !== undefined && (
          <div className="ml-auto flex basis-full justify-end sm:basis-auto">{children}</div>
        )}
      </div>
    </header>
  );
}
