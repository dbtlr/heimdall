import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { RoleSplit } from '../server/role-split-types.ts';
import { CostByRole } from './cost-by-role.tsx';

const cost = (pricedCostUsd: number) => ({ pricedCostUsd, requests: 10, unpricedRequests: 0 });

const SPLIT: RoleSplit = {
  classes: { delegated: cost(373.55), main: cost(512.3), review: cost(182) },
  seats: [
    { seat: 'breaker', ...cost(121.4) },
    { seat: null, ...cost(60.6) },
  ],
};

const text = (html: string) => html.replaceAll(/<[^>]+>/gu, '');

describe('CostByRole', () => {
  test('draws the strip, the three columns, the seats in the strip’s order, and the missed tags', () => {
    const html = renderToStaticMarkup(
      <CostByRole
        missedTags={{ rangeText: 'in 30 days', tags: { missed: 37, withRole: 212 } }}
        periodName="30 days"
        split={SPLIT}
      />,
    );

    expect(text(html)).toContain('Cost by role30 days, at list price');
    expect(html).toContain('aria-label="Main $512.30, Review $182.00, Delegated $373.55"');
    expect([...html.matchAll(/title="(?<label>[^"]+)"/gu)].map((m) => m.groups?.label)).toEqual([
      'Main',
      'review · breaker',
      'review · seat unknown',
      'Delegated',
      'breaker',
      'seat unknown',
    ]);
    expect(html).toContain('background:var(--review-unknown)');
    expect(text(html)).toContain('Review$182.0017%');
    expect(text(html)).toContain('breaker$121.40seat unknown$60.60');
    expect(text(html)).toContain(
      '37 of 212 Sessions with a role had no session tag and took it from T3&#x27;s preamble',
    );
  });

  test('without missed tags, leaves out the closing sentence, as a project page shows it', () => {
    const html = renderToStaticMarkup(<CostByRole periodName="7 days" split={SPLIT} />);

    expect(html).not.toContain('with a role');
  });

  test('flags unpriced requests that sit in review or delegated', () => {
    const html = renderToStaticMarkup(
      <CostByRole
        periodName="Today"
        split={{
          classes: {
            delegated: { pricedCostUsd: 1, requests: 4, unpricedRequests: 3 },
            main: cost(3),
            review: { pricedCostUsd: 1, requests: 3, unpricedRequests: 2 },
          },
          seats: [],
        }}
      />,
    );

    expect(text(html)).toContain('at least, 5 requests unpriced');
  });

  test('with no review cost, shows $0.00 for review and no seat list', () => {
    const html = renderToStaticMarkup(
      <CostByRole
        periodName="Today"
        split={{
          classes: { delegated: cost(1), main: cost(3), review: cost(0) },
          seats: [],
        }}
      />,
    );

    expect(text(html)).toContain('Review$0.000%');
    expect(html).not.toContain('Review by seat');
    expect([...html.matchAll(/title="(?<label>[^"]+)"/gu)].map((m) => m.groups?.label)).toEqual([
      'Main',
      'Delegated',
    ]);
  });

  test('with nothing priced, shows zero amounts and no strip', () => {
    const html = renderToStaticMarkup(
      <CostByRole
        periodName="Today"
        split={{
          classes: { delegated: cost(0), main: cost(0), review: cost(0) },
          seats: [],
        }}
      />,
    );

    expect(html).not.toContain('role="img"');
    expect(text(html)).toContain('Main$0.00');
  });
});
