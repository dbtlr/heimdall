import { describe, expect, test } from 'bun:test';

import { tileOrder } from '../lib/fleet-tile.ts';
import type { Attention } from '../server/attention-types.ts';
import type { SystemGlance } from '../server/fleet-overview-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { FleetTiles } from './fleet-tiles.tsx';
import { renderRouted } from './render-routed.tsx';

const NOW = 10_000_000;

const lane = (name: string, over: Partial<SystemGlance> = {}): SystemGlance => ({
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

const render = (lanes: SystemGlance[], items: Attention[] = []) =>
  renderRouted(<FleetTiles now={NOW} tiles={tileOrder(lanes, items, NOW)} />);

// The markup from the meter named `label` up to the next meter. A meter with an
// unknown percent is labelled "<label> unknown".
const meter = (html: string, label: string) =>
  html
    .split('<div aria-label="')
    .find((part) => part.startsWith(`${label}"`) || part.startsWith(`${label} unknown"`)) ?? '';

describe('a System tile', () => {
  test('links to its System and shows CPU, Mem, and the fullest Disk with rounded percents', async () => {
    const html = await render([lane('gateway-1')]);

    expect(html).toContain('href="/systems/gateway-1"');
    expect(meter(html, 'CPU')).toContain('aria-valuetext="CPU 12%"');
    expect(meter(html, 'Mem')).toContain('aria-valuetext="Mem 41%"');
    expect(meter(html, 'Disk')).toContain('aria-valuetext="Disk /data 74%"');
    expect(meter(html, 'Disk')).toContain('>74%<');
    expect(meter(html, 'Disk')).toContain('width:74%');
  });

  test('a meter says its level in words as well as color', async () => {
    const html = await render([lane('gateway-1')], [disk({ level: 'warning' })]);

    expect(meter(html, 'Disk')).toContain('aria-valuetext="Disk /data 74%, warning"');
    expect(meter(html, 'CPU')).not.toContain('warning');
  });

  test('an up, fresh, unsilenced System reads as healthy, with its Last seen age, and says nothing of old Vitals or silence', async () => {
    const html = await render([lane('gateway-1')]);

    expect(html).toContain('aria-label="Healthy"');
    expect(html).toContain('Last seen 20 s ago');
    expect(html).toContain('>20 s<');
    expect(html).not.toContain('Vitals as of');
    expect(html).not.toContain('opacity-50');
    expect(html).not.toContain('Alerts silenced');
  });

  test('alert and warning tiles say which they are', async () => {
    const alert = await render([lane('gateway-1')], [disk({ level: 'alert' })]);
    const warning = await render([lane('gateway-1')], [disk({ level: 'warning' })]);

    expect(alert).toContain('aria-label="Alert"');
    expect(alert).not.toContain('aria-label="Healthy"');
    expect(warning).toContain('aria-label="Warning"');
  });

  test('a System never seen says so, with no meters', async () => {
    const html = await render([
      lane('gateway-1', { lastSeenAt: undefined, latest: undefined, status: 'never_seen' }),
    ]);

    expect(html).toContain('aria-label="Never seen"');
    expect(html).toContain('>Never seen<');
    expect(html).toContain('No Vitals yet');
    expect(html).not.toContain('role="meter"');
  });

  test('missing memory is unknown: no value, an empty bar, and a label that says so', async () => {
    const base = lane('gateway-1');
    const html = await render([
      lane('gateway-1', {
        latest:
          base.latest === undefined ? undefined : { ...base.latest, memoryUsedPercent: undefined },
      }),
    ]);

    expect(meter(html, 'Mem')).toStartWith('Mem unknown"');
    expect(meter(html, 'Mem')).not.toContain('aria-valuenow');
    expect(meter(html, 'Mem')).not.toContain('role="meter"');
    expect(meter(html, 'Mem')).toContain('>—<');
    expect(meter(html, 'Mem')).toContain('width:0%');
  });

  test('an unpaired System keeps a visible Unpaired marker and says so', async () => {
    const html = await render([lane('gateway-1', { status: 'unpaired' })]);

    expect(html).toContain('aria-label="Unpaired"');
    expect(html).toContain('>Unpaired<');
    expect(html).not.toContain('aria-label="Healthy"');
  });
});

describe('stale Vitals', () => {
  test('old Vitals are muted and dated for screen readers, so they do not read as current', async () => {
    const base = lane('gateway-1');
    const html = await render([
      lane('gateway-1', {
        latest: base.latest === undefined ? undefined : { ...base.latest, t: NOW - 5 * 60_000 },
      }),
    ]);

    expect(html).toContain('Vitals as of 5 min ago');
    expect(html).toContain('opacity-50');
  });
});

describe('asleep and silenced Systems', () => {
  test('an asleep System shows the moon labelled Asleep instead of the healthy circle', async () => {
    const html = await render([
      lane('gateway-1', { lastSeenAt: NOW - 7 * 3_600_000, sleeps: true }),
    ]);

    expect(html).toContain('aria-label="Asleep"');
    expect(html).not.toContain('aria-label="Healthy"');
    expect(html).toContain('Last seen 7 h ago');
  });

  test('a silenced System keeps its health glyph and shows the time left', async () => {
    const html = await render(
      [lane('gateway-1', { silencedUntil: NOW + 2 * 3_600_000 - 30_000 })],
      [disk({ level: 'alert', subject: '/' })],
    );

    expect(html).toContain('aria-label="Alerts silenced, 2 h left"');
    expect(html).toContain('aria-label="Alert"');
    expect(html).not.toContain('Last seen');
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

    expect(html).toContain('aria-label="Healthy"');
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
    expect(html).toContain('aria-label="Alert"');
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
