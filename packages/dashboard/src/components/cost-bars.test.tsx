import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { CostBucket } from '../server/system-detail-types.ts';
import { CostBars, dollars } from './cost-bars.tsx';
import { DetailAxis } from './detail-track.tsx';

const DAY = 24 * 60 * 60_000;
const FROM = Date.UTC(2026, 9, 1);

const WINDOW = { from: FROM, to: FROM + 2 * DAY };

const render = (costs: CostBucket[]) =>
  renderToStaticMarkup(
    <DetailAxis onSelect={() => {}} selected={undefined} window={WINDOW}>
      <CostBars costs={costs} edges={[FROM, FROM + DAY, FROM + 2 * DAY]} window={WINDOW} />
    </DetailAxis>,
  );

const cost = (costUsd: number, unpriced = 0): CostBucket => ({
  costUsd,
  harness: 'claude-code',
  t: FROM,
  unpriced,
});

const ticks = (costs: CostBucket[]): (string | undefined)[] =>
  [...render(costs).matchAll(/data-scale-tick="[^"]*"[^>]*>([^<]*)</gu)].map((match) => match[1]);

describe('CostBars', () => {
  test('labels a scale under a dollar with cents, so no two ticks read alike', () => {
    const labels = ticks([cost(0.4)]);

    expect(new Set(labels).size).toBe(3);
    expect(labels).toContain('$0.50');
    expect(dollars(0.5)).toBe('$0.50');
    expect(dollars(5)).toBe('$5');
  });

  test('says "No list price" for a day with nothing priced', () => {
    const html = render([cost(0, 3)]);

    expect(html).toContain('title="No list price"');
    expect(html).not.toContain('$0.00');
  });

  test('says "At least" for a day mixing priced and unpriced requests', () => {
    expect(render([cost(2.5, 1)])).toContain('title="At least $2.50: Claude Code $2.50"');
  });

  test('gives an exact day its parts alone', () => {
    expect(render([cost(2.5)])).toContain('title="Claude Code $2.50"');
  });
});
