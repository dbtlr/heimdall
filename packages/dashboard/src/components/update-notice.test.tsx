import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { DashboardVersionRow, UpdatePill } from './update-notice.tsx';

const RUNNING = { build: '1.0.0+a', version: '1.0.0' };
const reload = () => undefined;

test('the pill shows only once a newer build is ready', () => {
  expect(renderToStaticMarkup(<UpdatePill onReload={reload} state={{ kind: 'unknown' }} />)).toBe(
    '',
  );
  expect(renderToStaticMarkup(<UpdatePill onReload={reload} state={{ kind: 'current' }} />)).toBe(
    '',
  );

  const html = renderToStaticMarkup(
    <UpdatePill onReload={reload} state={{ build: '1.1.0+b', kind: 'ready', version: '1.1.0' }} />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain('New version ready');
  expect(html).toMatch(/<button[^>]*>Reload<\/button>/u);
});

test('the pill floats above the phone tab bar and at the bottom of a wider window', () => {
  const html = renderToStaticMarkup(
    <UpdatePill onReload={reload} state={{ build: '1.1.0+b', kind: 'ready', version: '1.1.0' }} />,
  );
  expect(html).toContain('fixed');
  expect(html).toContain('bottom-[calc(5.25rem+env(safe-area-inset-bottom))]');
  expect(html).toContain('sm:bottom-6');
});

test('the More row names the running and ready versions and offers Update', () => {
  const html = renderToStaticMarkup(
    <DashboardVersionRow
      onReload={reload}
      running={RUNNING}
      state={{ build: '1.1.0+b', kind: 'ready', version: '1.1.0' }}
    />,
  );
  expect(html).toContain('Dashboard version');
  expect(html).toContain('Running v1.0.0 · v1.1.0 is ready');
  expect(html).toMatch(/<button[^>]*>Update<\/button>/u);
});

test('a newer build of the same release is named as a newer build', () => {
  const html = renderToStaticMarkup(
    <DashboardVersionRow
      onReload={reload}
      running={RUNNING}
      state={{ build: '1.0.0+b', kind: 'ready', version: '1.0.0' }}
    />,
  );
  expect(html).toContain('Running v1.0.0 · a newer build is ready');
});

test('once current, the More row says so and keeps a Reload', () => {
  const html = renderToStaticMarkup(
    <DashboardVersionRow onReload={reload} running={RUNNING} state={{ kind: 'current' }} />,
  );
  expect(html).toContain('v1.0.0 · up to date');
  expect(html).toMatch(/<button[^>]*>Reload<\/button>/u);
});

test('before the first check, the More row names the running version alone', () => {
  const html = renderToStaticMarkup(
    <DashboardVersionRow onReload={reload} running={RUNNING} state={{ kind: 'unknown' }} />,
  );
  expect(html).toContain('>v1.0.0<');
  expect(html).not.toContain('up to date');
  expect(html).toMatch(/<button[^>]*>Reload<\/button>/u);
});
