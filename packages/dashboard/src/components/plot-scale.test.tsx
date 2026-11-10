import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { PlotScale } from './plot-scale.tsx';

test('a percentage plot labels 100, 50, and 0 at the top, middle, and bottom', () => {
  const html = renderToStaticMarkup(<PlotScale domain={[0, 100]} />);
  expect(html).toMatch(/data-scale-tick="100" style="top:0%">100</u);
  expect(html).toMatch(/data-scale-tick="50" style="top:50%">50</u);
  expect(html).toMatch(/data-scale-tick="0" style="top:100%">0</u);
});

test('a limit draws a dashed line at its value, labelled in its color', () => {
  const html = renderToStaticMarkup(
    <PlotScale
      domain={[80, 100]}
      limits={[{ color: 'var(--status-serious)', label: 'limit 90%', value: 90 }]}
    />,
  );
  expect(html).toMatch(
    /class="[^"]*border-dashed[^"]*" data-limit="90" style="border-color:var\(--status-serious\);top:50%"/u,
  );
  expect(html).toContain('limit 90%');
});
