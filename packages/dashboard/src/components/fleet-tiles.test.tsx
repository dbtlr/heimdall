import { describe, expect, test } from 'bun:test';

import { tileOrder } from '../lib/fleet-tile.ts';
import type { Attention } from '../server/attention-types.ts';
import type { Lane } from '../server/fleet-overview-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { FleetTiles } from './fleet-tiles.tsx';
import { renderRouted } from './render-routed.tsx';

const NOW = 10_000_000;

const lane = (name: string, over: Partial<Lane> = {}): Lane => ({
  buckets: [],
  conditions: [],
  gaps: [],
  lastSeenAt: NOW - 20_000,
  latest: {
    cpuBusyPercent: 12.4,
    disks: [
      { mount: '/', totalBytes: 100, usedBytes: 40 },
      { mount: '/data', totalBytes: 100, usedBytes: 74 },
    ],
    memoryUsedPercent: 41.2,
    t: NOW - 20_000,
  },
  name,
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  stretches: [],
  ...over,
});

const disk = (over: Partial<Extract<Attention, { kind: 'low_disk' }>> = {}): Attention => ({
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
  ...over,
});

const render = (lanes: Lane[], items: Attention[] = []) =>
  renderRouted(<FleetTiles now={NOW} tiles={tileOrder(lanes, items, NOW)} />);

// The markup from the meter named `label` up to the next meter.
const meter = (html: string, label: string) =>
  html.split('<div aria-label="').find((part) => part.startsWith(`${label}"`)) ?? '';

describe('a System tile', () => {
  test('links to its System and shows CPU, Mem, and the fullest Disk with rounded percents', async () => {
    const html = await render([lane('gateway-1')]);

    expect(html).toContain('href="/systems/gateway-1"');
    expect(meter(html, 'CPU')).toContain('>12%<');
    expect(meter(html, 'Mem')).toContain('>41%<');
    expect(meter(html, 'Disk')).toContain('>74%<');
    expect(meter(html, 'Disk')).toContain('width:74%');
  });

  test('an up System shows the healthy circle and the time since Last seen', async () => {
    const html = await render([lane('gateway-1')]);

    expect(html).toContain('stroke-status-good');
    expect(html).toContain('>20 s<');
  });

  test('a System never seen shows an unknown glyph and a dash for its age', async () => {
    const html = await render([
      lane('gateway-1', { lastSeenAt: undefined, latest: undefined, status: 'never_seen' }),
    ]);

    expect(html).toContain('stroke-muted-foreground');
    expect(html).not.toContain('stroke-status-good');
    expect(html).toContain('>—<');
    expect(html).toContain('No Vitals yet');
    expect(html).not.toContain('role="meter"');
  });

  test('missing memory reads as a dash with an empty bar', async () => {
    const base = lane('gateway-1');
    const html = await render([
      lane('gateway-1', {
        latest:
          base.latest === undefined ? undefined : { ...base.latest, memoryUsedPercent: undefined },
      }),
    ]);

    expect(meter(html, 'Mem')).toContain('>—<');
    expect(meter(html, 'Mem')).toContain('width:0%');
  });

  test('an unpaired System keeps a visible Unpaired marker and an unknown glyph', async () => {
    const html = await render([lane('gateway-1', { status: 'unpaired' })]);

    expect(html).toContain('>Unpaired<');
    expect(html).toContain('border-dashed');
    expect(html).not.toContain('stroke-status-good');
  });
});

describe('asleep and silenced Systems', () => {
  test('an asleep System shows a labelled moon in the status slot instead of the healthy circle', async () => {
    const html = await render([
      lane('gateway-1', { lastSeenAt: NOW - 7 * 3_600_000, sleeps: true }),
    ]);

    expect(html).toContain('aria-label="Asleep"');
    expect(html).toContain('lucide-moon');
    expect(html).not.toContain('stroke-status-good');
    expect(html).toContain('>7 h<');
  });

  test('a silenced System keeps its health glyph and shows the bell with the time left', async () => {
    const html = await render(
      [lane('gateway-1', { silencedUntil: NOW + 2 * 3_600_000 - 30_000 })],
      [disk({ level: 'alert', subject: '/' })],
    );

    expect(html).toContain('aria-label="Alerts silenced, 2 h left"');
    expect(html).toContain('lucide-bell-off');
    expect(html).toContain('fill-status-critical');
    expect(html).not.toContain('>20 s<');
  });

  test('a System that is not silenced shows no bell', async () => {
    expect(await render([lane('gateway-1')])).not.toContain('lucide-bell-off');
  });
});

describe('meter levels and the worst Condition', () => {
  test('a low_disk note colors only the Disk meter', async () => {
    const html = await render([lane('gateway-1')], [disk()]);

    expect(meter(html, 'Disk')).toContain(MARK_COLOR.note);
    expect(meter(html, 'Disk')).toContain('bg-status-warning');
    expect(meter(html, 'CPU')).not.toContain(MARK_COLOR.note);
    expect(meter(html, 'Mem')).not.toContain('bg-status-warning');
  });

  test('a note leaves the System healthy and names no Condition under the meters', async () => {
    const html = await render([lane('gateway-1')], [disk()]);

    expect(html).toContain('stroke-status-good');
    expect(html).not.toContain('Low disk');
  });

  test('the worst alert or warning is named with its subject, and +1 counts the other', async () => {
    const html = await render(
      [lane('gateway-1', { status: 'needs_you' })],
      [
        disk({ conditionId: 'a', level: 'alert', subject: '/' }),
        disk({ conditionId: 'b', level: 'warning', subject: '/data' }),
      ],
    );

    expect(html).toContain('Low disk');
    expect(html).toContain('>/<');
    expect(html).toContain('>+1<');
    expect(html).toContain('fill-status-critical');
    expect(html).not.toContain('>/data<');
  });

  test('unconfirmed evidence stays visible through the dashed pill', async () => {
    const html = await render(
      [lane('gateway-1')],
      [
        {
          checkedAt: undefined,
          evidence: 'old',
          firstDetected: 0,
          kind: 'checks_missing',
          set: 'checks',
          subject: '',
          system: 'gateway-1',
          unpaired: false,
        },
      ],
    );

    expect(html).toContain('>1?<');
    expect(html).toContain('title="unconfirmed evidence"');
  });
});

describe('tile order', () => {
  test('lists Systems with alerts first', async () => {
    const html = await render(
      [lane('alpha-1'), lane('zulu-1')],
      [disk({ level: 'alert', system: 'zulu-1' })],
    );

    expect(html.indexOf('zulu-1')).toBeLessThan(html.indexOf('alpha-1'));
  });
});
