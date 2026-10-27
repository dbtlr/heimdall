import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { AppNavigation, ServiceAttentionCount } from '../components/app-navigation.tsx';
import { AppSidebar } from '../components/app-sidebar.tsx';
import { AutoRefresh } from '../components/auto-refresh.tsx';
import { isNarrowBrowser } from '../lib/layout.ts';
import { getFleetGlance } from '../server/fleet-overview-fn.ts';
import { getServiceAttentionCount } from '../server/services-fn.ts';

import appCss from '../styles.css?url';

// The sidebar lists every System, unpaired ones included, on every page from
// `lg`. A phone's browser skips the read; the server cannot tell, so a first
// load always reads it. A failed read leaves the sidebar without Systems
// rather than failing every page.
const readSidebarGlance = async () => {
  if (isNarrowBrowser()) {
    return undefined;
  }
  try {
    return await getFleetGlance({ data: { unpaired: true } });
  } catch {
    return undefined;
  }
};

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
  loader: async () => {
    const [count, glance] = await Promise.all([getServiceAttentionCount(), readSidebarGlance()]);
    return { count, glance };
  },
  shellComponent: ({ children }: { children: ReactNode }) => (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] sm:pb-0 lg:pl-[248px]">
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
  const { count, glance } = Route.useLoaderData();
  return (
    <ServiceAttentionCount value={count}>
      <AutoRefresh />
      <div className="fixed inset-y-0 left-0 z-40 hidden w-[248px] lg:flex">
        <AppSidebar glance={glance} />
      </div>
      <Outlet />
      <div className="sm:hidden">
        <AppNavigation />
      </div>
    </ServiceAttentionCount>
  );
}
