import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { AppNavigation } from '../components/app-navigation.tsx';
import { AutoRefresh } from '../components/auto-refresh.tsx';

import appCss from '../styles.css?url';

export const Route = createRootRoute({
  component: () => (
    <>
      <AutoRefresh />
      <Outlet />
      <div className="sm:hidden">
        <AppNavigation />
      </div>
    </>
  ),
  head: () => ({
    // The icons are files in public/ at fixed paths: mobile Safari showed no
    // icon for an SVG inlined in the page, and wants the PNG apple-touch-icon.
    links: [
      { href: appCss, rel: 'stylesheet' },
      { href: '/favicon.ico', rel: 'icon', sizes: '32x32' },
      { href: '/favicon.svg', rel: 'icon', type: 'image/svg+xml' },
      { href: '/apple-touch-icon.png', rel: 'apple-touch-icon' },
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
      <body className="pb-[calc(4rem+env(safe-area-inset-bottom))] sm:pb-0">
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
