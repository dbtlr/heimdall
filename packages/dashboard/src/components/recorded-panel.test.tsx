import { expect, test } from 'bun:test';

import type { ListedService } from '../server/system-detail-types.ts';
import { RecordedPanel } from './recorded-panel.tsx';
import { renderRouted } from './render-routed.tsx';

const service = (version: string | null, update: string | undefined): ListedService => ({
  checks: [],
  name: 'caddy',
  supervisor: 'systemd',
  update,
  version,
});

const renderPanel = (services: ListedService[]) =>
  renderRouted(
    <RecordedPanel
      now={0}
      recorded={{ applications: [], files: [], jobs: [], services }}
      system="server-1"
    />,
  );

test('reads a Service whose installed version is unknown as a muted "unknown", as the Services page does', async () => {
  const html = await renderPanel([service(null, undefined)]);

  expect(html).toContain('<span class="text-muted-foreground">unknown</span>');
});

test("sets a Service's version and update in normal weight beside its bold name", async () => {
  const html = await renderPanel([service('0.10.1', '0.10.2')]);
  const [bold = ''] = /<b[^>]*>.*?<\/b>/su.exec(html) ?? [];

  expect(bold).toContain('caddy');
  expect(bold).not.toContain('0.10.1');
  expect(bold).not.toContain('0.10.2');
  expect(html).toContain('0.10.1');
  expect(html).toContain('→ 0.10.2');
});
