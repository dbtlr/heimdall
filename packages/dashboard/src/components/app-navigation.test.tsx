import { expect, test } from 'bun:test';

import type { ReactNode } from 'react';

import { AppNavigation, ServiceAttentionCount } from './app-navigation.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const PATHS = ['/', '/services', '/agents', '/timeline', '/more', '/systems', '/systems/$name'];

const renderAt = (path: string, element: ReactNode) =>
  renderRouted(element, { path, routePaths: PATHS });

test('the phone bar holds Home, Services, Agents, Activity, and More, each with an icon screen readers skip', async () => {
  const html = await renderAt('/', <AppNavigation />);
  expect(linksIn(html)).toEqual([
    { current: true, href: '/', icon: true, label: 'Home' },
    { current: false, href: '/services', icon: true, label: 'Services' },
    { current: false, href: '/agents', icon: true, label: 'Agents' },
    { current: false, href: '/timeline', icon: true, label: 'Activity' },
    { current: false, href: '/more', icon: true, label: 'More' },
  ]);
});

for (const [path, active] of [
  ['/agents', 'Agents'],
  ['/systems/server-1', 'More'],
  ['/more', 'More'],
] as const) {
  test(`the phone bar marks ${active} on ${path}`, async () => {
    const html = await renderAt(path, <AppNavigation />);
    expect(linksIn(html).flatMap((tab) => (tab.current ? [tab.label] : []))).toEqual([active]);
  });
}

for (const count of [0, 3]) {
  test(`Services navigation badge ${count === 0 ? 'hides at zero' : 'shows the attention count'}`, async () => {
    const html = await renderAt(
      '/',
      <ServiceAttentionCount value={count}>
        <AppNavigation />
      </ServiceAttentionCount>,
    );
    expect(html.includes('<span class="sr-only">3 Services down or restarted</span>')).toBe(
      count > 0,
    );
    if (count > 0) {
      expect(html).toMatch(/<span aria-hidden="true"[^>]*>3<\/span>/u);
      // On the icon's corner, not beside the label, so the tab keeps its width.
      expect(html).toMatch(/<\/svg><span aria-hidden="true" class="absolute[^"]*">3<\/span>/u);
      expect(html).toContain('<span>Services</span>');
    }
  });
}
