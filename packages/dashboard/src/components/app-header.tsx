import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

// The brand and navigation, with `children` at the right end.
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-3.5 px-3.5 py-2.5 sm:gap-[22px] sm:px-[22px] sm:py-3">
        <span className="text-base font-bold tracking-[0.02em]">Heimdall</span>
        <nav aria-label="Main navigation" className="flex gap-4">
          <Link
            activeOptions={{ exact: true, includeSearch: false }}
            activeProps={{ 'aria-current': 'page', className: 'font-semibold' }}
            className="text-muted-foreground aria-[current=page]:text-foreground"
            to="/"
          >
            Fleet
          </Link>
          <Link
            activeOptions={{ exact: true, includeSearch: false }}
            activeProps={{ 'aria-current': 'page', className: 'font-semibold' }}
            className="text-muted-foreground aria-[current=page]:text-foreground"
            to="/agents"
          >
            Agents
          </Link>
        </nav>
        {children !== undefined && (
          <div className="ml-auto flex basis-full justify-end sm:basis-auto">{children}</div>
        )}
      </div>
    </header>
  );
}
