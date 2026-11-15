import { expect, test } from 'bun:test';

import { AgentsLegend } from './agents-breakdown.tsx';
import { renderRouted } from './render-routed.tsx';
import { SessionTitle } from './session-header.tsx';

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

test('a project named . or .. links nowhere, from the Agents legend or a Session page', async () => {
  for (const name of ['.', '..']) {
    // oxlint-disable-next-line no-await-in-loop -- two names.
    const legend = await renderRouted(<AgentsLegend by="project" pick={name} rows={[]} />);
    expect(legend).not.toContain('/projects');
    expect(legend).not.toContain(`Open ${name}`);
    // oxlint-disable-next-line no-await-in-loop -- two names.
    const title = await renderRouted(
      <SessionTitle
        view={{ branch: 'main', harness: 'codex', project: name, system: 'server-1' }}
      />,
    );
    expect(title).not.toContain('/projects');
    expect(title).toContain(` ${name}`);
  }
});
