import { expect, test } from 'bun:test';

import { renderRouted } from './render-routed.tsx';
import { ServicesTable } from './services-table.tsx';

test('Service rows link to detail, expose status, and date down from the Condition', async () => {
  const html = await renderRouted(
    <ServicesTable
      now={120_000}
      rows={[
        { downSince: 0, latestStopAt: undefined, name: 'web', status: 'down', system: 'alpha' },
        {
          downSince: undefined,
          latestStopAt: 60_000,
          name: 'api',
          status: 'restarted',
          system: 'beta',
        },
        {
          downSince: undefined,
          latestStopAt: undefined,
          name: 'worker',
          status: 'unknown',
          system: 'beta',
        },
      ]}
    />,
  );
  expect(html).toContain('href="/systems/alpha/services/web"');
  expect(html).toContain('href="/systems/beta/services/api"');
  expect(html).toContain('Down 2 min');
  expect(html).toContain('restarted');
  expect(html).toContain('unknown');
  expect(html).toContain('bg-status-critical');
  expect(html).toContain('bg-primary');
  expect(html).toContain('border-muted-foreground');
  expect(html).toContain('Service</th>');
  expect(html).toContain('System</th>');
  expect(html).not.toContain('Version');
});
