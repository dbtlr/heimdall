import type { ReactNode } from 'react';

import { contentFrame } from '../lib/layout.ts';
import { cn } from '../lib/utils.ts';

// A page's own tools, such as a range picker, at the right end of a row under
// the top bar.
export function PageToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="border-b">
      <div className={cn(contentFrame('wide'), 'flex justify-end py-2.5 sm:py-3')}>{children}</div>
    </div>
  );
}
