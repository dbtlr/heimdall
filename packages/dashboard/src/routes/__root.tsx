import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { AutoRefresh } from '../components/auto-refresh.tsx';
import favicon from '../favicon.svg?url';

import appCss from '../styles.css?url';

export const Route = createRootRoute({
  component: () => (
    <>
      <AutoRefresh />
      <Outlet />
    </>
  ),
  head: () => ({
    links: [
      { href: appCss, rel: 'stylesheet' },
      { href: favicon, rel: 'icon', type: 'image/svg+xml' },
    ],
    meta: [
      // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- HTML wants the name "utf-8".
      { charSet: 'utf-8' },
      { content: 'width=device-width, initial-scale=1', name: 'viewport' },
      { title: 'Heimdall' },
    ],
  }),
  shellComponent: ({ children }: { children: ReactNode }) => (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
