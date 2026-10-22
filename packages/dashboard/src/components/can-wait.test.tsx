import { expect, test } from 'bun:test';

import { CanWait } from './can-wait.tsx';
import { renderRouted } from './render-routed.tsx';

test('one row per System lists its notes joined by dots, and links to the System', async () => {
  const html = await renderRouted(
    <CanWait
      rows={[
        { notes: ['Low disk /', 'Reboot required'], system: 'gateway-1' },
        { notes: ['Pending update APT (system)'], system: 'laptop-1' },
      ]}
    />,
  );

  expect(html).toContain('Can wait');
  expect(html).toContain('href="/systems/gateway-1"');
  expect(html).toContain('Low disk / · Reboot required');
  expect(html).toContain('href="/systems/laptop-1"');
  expect(html.indexOf('gateway-1')).toBeLessThan(html.indexOf('laptop-1'));
  expect(html).toContain('fill-status-warning');
});

test('nothing renders when no System has a note', async () => {
  expect(await renderRouted(<CanWait rows={[]} />)).toBe('');
});
