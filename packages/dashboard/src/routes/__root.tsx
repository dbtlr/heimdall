import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { AppNavigation, ServiceAttentionCount } from '../components/app-navigation.tsx';
import { AutoRefresh } from '../components/auto-refresh.tsx';
import { getServiceAttentionCount } from '../server/services-fn.ts';

import appCss from '../styles.css?url';

export const Route = createRootRoute({
  component: Root,
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
      { content: 'width=device-width, initial-scale=1, viewport-fit=cover', name: 'viewport' },
      { title: 'Heimdall' },
    ],
  }),
  loader: () => getServiceAttentionCount(),
  shellComponent: ({ children }: { children: ReactNode }) => (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] sm:pb-0">
        {/* Safari samples a real fixed element's opaque background for its status bar.
            Touch and narrow layouts need 6px even when the top safe area is zero. */}
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-0 z-30 h-[max(6px,env(safe-area-inset-top))] bg-card sm:bg-background sm:pointer-fine:h-[env(safe-area-inset-top)]"
        />
        {children}
        <Scripts />
      </body>
    </html>
  ),
});

function Root() {
  const count = Route.useLoaderData();
  return (
    <ServiceAttentionCount value={count}>
      <AutoRefresh />
      <Outlet />
      <div className="sm:hidden">
        <AppNavigation />
      </div>
    </ServiceAttentionCount>
  );
}
