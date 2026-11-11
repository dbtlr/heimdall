import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { FleetVerdict } from '../components/fleet-verdict.tsx';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('the body does not set tabular figures, which would space out hyphenated names', async () => {
  expect(await read('../styles.css')).not.toContain('font-variant-numeric');
});

test('figures opt in to tabular figures, and the name elements never do', async () => {
  const verdict = renderToStaticMarkup(<FleetVerdict counts={{ alert: 1, note: 0, warning: 0 }} />);
  expect(verdict).toContain('tabular-nums');
  const tiles = await read('../components/fleet-tiles.tsx');
  const names = tiles.split('\n').filter((line) => line.includes('tile.lane.name'));
  expect(names.length).toBeGreaterThan(0);
  for (const line of names) {
    expect(line).not.toContain('tabular-nums');
  }
});
