import type { ReactNode } from 'react';

// The brand and navigation, with `children` at the right end.
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-[1200px] items-center gap-3.5 px-3.5 py-2.5 sm:gap-[22px] sm:px-[22px] sm:py-3">
        <span className="text-base font-bold tracking-[0.02em]">Heimdall</span>
        <nav className="hidden gap-4 sm:flex">
          <span aria-current="page" className="font-semibold">
            Fleet
          </span>
        </nav>
        {children}
      </div>
    </header>
  );
}
