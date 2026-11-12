import type { ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

// Expanded long lists scroll within their disclosure to keep local navigation
// near. A short one that is not `scrolls` grows instead, so nothing it holds,
// such as a plot's scale in the gutter, is clipped at the disclosure's edge.
export function MoreItems({
  children,
  label,
  scrolls = true,
}: {
  children: ReactNode;
  label: string;
  scrolls?: boolean;
}) {
  return (
    <details className="my-2 border-y">
      <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-base text-primary">
        {label}
      </summary>
      <div className={cn('pb-2', scrolls && 'max-h-[50dvh] overflow-y-auto overscroll-contain')}>
        {children}
      </div>
    </details>
  );
}
