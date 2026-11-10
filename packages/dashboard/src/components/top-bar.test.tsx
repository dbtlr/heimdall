import { expect, test } from 'bun:test';

import type { FleetSummary } from '../lib/fleet.ts';
import { linksIn, renderRouted } from './render-routed.tsx';
import { TopBar } from './top-bar.tsx';

const PATHS = ['/', '/services', '/agents', '/timeline', '/systems', '/systems/$name', '/more'];

const fleet: FleetSummary = {
  counts: { alert: 0, note: 1, warning: 2 },
  systems: 3,
  verdictShown: true,
  worst: 'warning',
};

const renderAt = (path: string, summary: FleetSummary | undefined) =>
  renderRouted(
    <TopBar
      fleet={summary}
      loadJumpIndex={() =>
        Promise.resolve({ projects: [], services: [], sessions: [], systems: [] })
      }
    />,
    { path, routePaths: PATHS },
  );

test('the top bar links the six sections in order, marks the one the page belongs to, and holds the verdict and jump box', async () => {
  const html = await renderAt('/systems/server-1?tab=vitals', fleet);

  expect(linksIn(html)).toEqual([
    { current: false, href: '/', icon: false, label: 'Home' },
    { current: true, href: '/systems', icon: false, label: 'Systems' },
    { current: false, href: '/services', icon: false, label: 'Services' },
    { current: false, href: '/agents', icon: false, label: 'Agents' },
    {
      current: false,
      href: '/services?status=%5B%22updates%22%5D',
      icon: false,
      label: 'Maintenance',
    },
    { current: false, href: '/timeline', icon: false, label: 'Activity' },
  ]);
  expect(html).toContain('aria-label="2 warnings, 1 note"');
  expect(html).toContain('role="combobox"');
});

test('Maintenance is marked on the Services page filtered to updates, and nothing on More', async () => {
  const maintenance = await renderAt('/services?status=%5B%22updates%22%5D', fleet);
  const more = await renderAt('/more', fleet);

  expect(linksIn(maintenance).flatMap((link) => (link.current ? [link.label] : []))).toEqual([
    'Maintenance',
  ]);
  expect(linksIn(more).filter((link) => link.current)).toEqual([]);
});

test('without a fleet summary the bar leaves the verdict out', async () => {
  const html = await renderAt('/', undefined);

  expect(html).not.toContain('All clear');
  expect(html).not.toContain('role="img"');
});
