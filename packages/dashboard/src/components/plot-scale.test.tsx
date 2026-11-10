import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ScaledPlot } from './plot-scale.tsx';
import type { PlotLimit } from './plot-scale.tsx';

// A plot's scale and limits, drawn around an empty plot.
const scaleOf = (domain: [number, number], limits: PlotLimit[] = []): string =>
  renderToStaticMarkup(
    <ScaledPlot domain={domain} height={40} limits={limits}>
      <svg />
    </ScaledPlot>,
  );

test('a percentage plot labels 100, 50, and 0 at the top, middle, and bottom', () => {
  const html = scaleOf([0, 100]);
  expect(html).toMatch(/data-scale-tick="100" style="top:0%">100</u);
  expect(html).toMatch(/data-scale-tick="50" style="top:50%">50</u);
  expect(html).toMatch(/data-scale-tick="0" style="top:100%">0</u);
});

test('a limit draws a dashed line at its value, labelled in its color', () => {
  const html = scaleOf(
    [80, 100],
    [{ color: 'var(--status-serious)', label: 'limit 90%', value: 90 }],
  );
  expect(html).toMatch(
    /class="[^"]*border-dashed[^"]*" data-limit="90" style="border-color:var\(--status-serious\);top:50%"/u,
  );
  expect(html).toContain('limit 90%');
});

// The class list of the element carrying `marker`, such as `data-scale-tick="50"`.
const classOf = (html: string, marker: string): string =>
  new RegExp(`class="([^"]*)" ${marker}`, 'u').exec(html)?.[1] ?? '';

test('the top label hangs below the top edge, the bottom one stands on the bottom edge, the middle centres', () => {
  const html = scaleOf([0, 100]);
  expect(classOf(html, 'data-scale-tick="100"')).not.toContain('translate-y');
  expect(classOf(html, 'data-scale-tick="50"')).toContain('-translate-y-1/2');
  expect(classOf(html, 'data-scale-tick="0"')).toContain('-translate-y-full');
});

// The class list of the label of a limit at `value` on a 0 to 100 scale.
const limitLabelClass = (value: number): string =>
  new RegExp(`data-limit="${String(value)}"[^>]*><span class="([^"]*)"`, 'u').exec(
    scaleOf([0, 100], [{ color: 'red', label: 'limit', value }]),
  )?.[1] ?? '';

test('a limit label sits below its line, and above it when the line is near the bottom', () => {
  expect(limitLabelClass(50)).toContain('top-1');
  expect(limitLabelClass(20)).toContain('top-1');
  expect(limitLabelClass(10)).toContain('bottom-1');
});

const LIMIT = { color: 'var(--status-warning)', label: 'warn 80%', value: 80 };

for (const gutter of [false, true]) {
  test(`a scaled plot ${gutter ? 'with' : 'without'} a gutter draws its scale and its limits around the plot`, () => {
    const html = renderToStaticMarkup(
      <ScaledPlot domain={[0, 100]} gutter={gutter} height={40} limits={[LIMIT]}>
        <svg data-plot="drawn" />
      </ScaledPlot>,
    );
    expect(html).toContain('<svg data-plot="drawn"');
    expect(html.match(/data-scale-tick=/gu)).toHaveLength(3);
    expect(html).toMatch(/data-limit="80" style="[^"]*top:20%"/u);
  });
}

test('a scale label laid over the plot sits on a card-colored backing, so the line does not run through it', () => {
  const html = scaleOf([0, 100]);
  for (const value of [0, 50, 100]) {
    expect(classOf(html, `data-scale-tick="${String(value)}"`)).toContain('bg-card/');
  }
  expect(limitLabelClass(50)).toContain('bg-card/');
});

test('a scaled plot with no reading to scale draws no labels, so it states no scale', () => {
  const html = renderToStaticMarkup(
    <ScaledPlot domain={[0, 1]} height={40} labelled={false}>
      <svg />
    </ScaledPlot>,
  );
  expect(html).not.toContain('data-scale-tick');
});
