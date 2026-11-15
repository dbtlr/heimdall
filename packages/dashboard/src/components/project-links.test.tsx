import { expect, test } from 'bun:test';

import { AgentsLegend } from './agents-breakdown.tsx';
import { renderRouted } from './render-routed.tsx';

test('a picked project retains its Agents filter and offers the encoded dossier link', async () => {
  const html = await renderRouted(
    <AgentsLegend
      by="project"
      pick="notes app"
      rows={[
        {
          color: 'red',
          key: 'notes app',
          name: 'notes app',
          percent: 100,
          pricedCostUsd: 1,
          pricing: 'exact',
          requests: 1,
          unpricedRequests: 0,
        },
      ]}
    />,
  );
  expect(html).toContain('href="/projects/notes%20app"');
  expect(html).toContain('Open notes app');
});

test('the empty project key never links to a dossier', async () => {
  const html = await renderRouted(<AgentsLegend by="project" pick="" rows={[]} />);
  expect(html).not.toContain('/projects/');
});
