import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { VitalsWindow } from '../server/vitals-window-types.ts';
import { VitalsWindowCard } from './vitals-window.tsx';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const MINUTE = 60_000;

const vitals: VitalsWindow = {
  bucketMs: MINUTE,
  from: NOW - 60 * MINUTE,
  limits: { cpuPercent: 90, memoryPercent: 90 },
  points: Array.from({ length: 60 }, (_, index) => ({
    cpu: 40,
    load: 1.5,
    memory: 60,
    t: NOW - (60 - index) * MINUTE,
  })),
  source: 'samples',
  to: NOW,
};

test('the shade lies under each plot, so it never runs through a scale label', () => {
  const html = renderToStaticMarkup(
    <VitalsWindowCard
      shade={{ from: NOW - 58 * MINUTE, to: NOW }}
      title="Around"
      vitals={vitals}
    />,
  );
  // What follows each shade, up to the next: the plot it lies under comes after it.
  const plots = html.split('data-shade="true"').slice(1);
  expect(plots).toHaveLength(3);
  for (const plot of plots) {
    expect(plot).toContain('data-scale-tick=');
  }
});
