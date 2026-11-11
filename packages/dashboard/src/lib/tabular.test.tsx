import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { DateTime } from '../components/date-time.tsx';
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

test('the shared time component, the nav count, and the stacked cost carry tabular figures', async () => {
  const time = renderToStaticMarkup(<DateTime at={0} format="clock" />);
  expect(time).toContain('<time class="tabular-nums"');
  expect(await read('../components/app-navigation.tsx')).toContain(
    "font-semibold text-primary tabular-nums'",
  );
  expect(await read('../components/session-timeline.tsx')).toContain(
    'text-muted-foreground tabular-nums">{formatCost(lane.costUsd)}',
  );
});
