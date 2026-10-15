import type { ReactNode } from 'react';

// Expanded long lists scroll within their disclosure to keep local navigation near.
export function MoreItems({ children, label }: { children: ReactNode; label: string }) {
  return (
    <details className="my-2 border-y">
      <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-base text-primary">
        {label}
      </summary>
      <div className="max-h-[50dvh] overflow-y-auto overscroll-contain pb-2">{children}</div>
    </details>
  );
}
