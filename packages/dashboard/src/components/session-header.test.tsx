import { expect, test } from 'bun:test';

import { renderRouted } from './render-routed.tsx';
import { SessionTitle } from './session-header.tsx';

test('a Session page starts its breadcrumb with Agents, then the System', async () => {
  const html = await renderRouted(
    <SessionTitle
      view={{ branch: 'main', harness: 'codex', project: 'heimdall', system: 'server-1' }}
    />,
  );

  expect(html).toMatch(/<a[^>]*href="\/agents"[^>]*>Agents<\/a>/u);
  expect(html).toContain('href="/systems/server-1"');
  expect(html).not.toContain('Fleet');
});
