import { describe, expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import type { FleetGlance, FleetOverview, Lane } from '../server/fleet-overview-types.ts';
import { FleetWide } from './fleet-wide.tsx';
import { renderRouted } from './render-routed.tsx';

const NOW = 10_000_000;

const lane = (name: string): Lane => ({
  buckets: [],
  conditions: [],
  gaps: [],
  lastSeenAt: NOW - 20_000,
  latest: undefined,
  name,
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  stretches: [],
});

const note: Attention = {
  checkedAt: NOW,
  conditionId: 'c-disk',
  disk: undefined,
  evidence: 'current',
  firstDetected: 100,
  kind: 'low_disk',
  level: 'note',
  reason: '74% used',
  subject: '/data',
  system: 'gateway-1',
  unpaired: false,
};

const glance: FleetGlance<Lane> = {
  attention: [note],
  deliveryFailingSince: undefined,
  lanes: [lane('gateway-1'), lane('laptop')],
  now: NOW,
  unpairedCount: 0,
  unpairedLanes: [],
};

const overview: FleetOverview = { ...glance, from: NOW - 86_400_000, range: '24h', to: NOW };

const render = (data: FleetGlance | FleetOverview, deliveryFailingSince?: number) =>
  renderRouted(
    <FleetWide
      data={data}
      deliveryFailingSince={deliveryFailingSince}
      range="24h"
      showUnpaired={false}
    />,
  );

describe('the wide Fleet view', () => {
  test('puts the Fleet heading before the delivery-failing strip', async () => {
    const pages = await Promise.all([overview, glance].map((data) => render(data, NOW - 60_000)));
    for (const html of pages) {
      const strip = html.search(/delivery/i);
      expect(strip).toBeGreaterThan(-1);
      expect(html.indexOf('<h1')).toBeGreaterThan(-1);
      expect(html.indexOf('<h1')).toBeLessThan(strip);
    }
  });

  test('with the overview, shows a lane per System, the legend, and Open now, from lg only', async () => {
    const html = await render(overview);

    expect(html).toContain('class="hidden lg:block"');
    expect(html).toContain('<h1 class="text-2xl font-semibold">Fleet</h1>');
    expect(html).toContain('aria-label="gateway-1"');
    expect(html).toContain('aria-label="laptop"');
    expect(html).toContain('aria-label="Range"');
    expect(html).toContain('Open now');
    expect(html).not.toContain('Loading lanes');
  });

  test('with only the glance, keeps the header over a placeholder and draws no lanes', async () => {
    const html = await render(glance);

    expect(html).toContain('class="hidden lg:block"');
    expect(html).toContain('>Fleet</h1>');
    expect(html).toContain('aria-label="Range"');
    expect(html).toContain('Loading lanes');
    expect(html).not.toContain('aria-label="gateway-1"');
    expect(html).not.toContain('Open now');
  });
});
