import { expect, test } from 'bun:test';

import type { ActivityLine } from '../lib/activity.ts';
import type { AxisLane } from '../server/activity-types.ts';
import { ActivityAxisBody, trackPointer } from './activity-axis.tsx';
import { renderRouted } from './render-routed.tsx';

// A lane track 100 px wide whose time is its x in minutes.
const setup = () => {
  const drags: (number | undefined)[] = [];
  const pins: number[] = [];
  const pointer = trackPointer({
    at: ({ clientX }) => clientX,
    onDrag: (at) => drags.push(at),
    onPin: (at) => pins.push(at),
  });
  const down = (clientX: number) => {
    pointer.onPointerDown({
      clientX,
      currentTarget: { setPointerCapture: () => {} },
      pointerId: 1,
    });
  };
  return { down, drags, pins, pointer };
};

test('a drag shows its line under the pointer and pins where it is released', () => {
  const { down, drags, pins, pointer } = setup();
  down(10);
  pointer.onPointerMove({ clientX: 20 });
  pointer.onPointerUp({ clientX: 30 });
  expect(drags).toEqual([10, 20, undefined]);
  expect(pins).toEqual([30]);
});

test('a pointer the browser takes back for a scroll ends the drag with no line and no pin', () => {
  const { down, drags, pins, pointer } = setup();
  down(10);
  pointer.onPointerCancel();
  // A move after it, as the page scrolls, draws nothing.
  pointer.onPointerMove({ clientX: 40 });
  pointer.onPointerUp({ clientX: 40 });
  expect(drags).toEqual([10, undefined]);
  expect(pins).toEqual([]);
});

const NOW = Date.UTC(2026, 10, 14, 12);
const DAY = 24 * 60 * 60_000;

const lane = (system: string, unpaired: boolean): AxisLane => ({
  buckets: [],
  cpuLimit: undefined,
  stretches: [],
  system,
  unpaired,
});

const renderAxis = (lanes: readonly AxisLane[], lines: readonly ActivityLine[] = []) =>
  renderRouted(
    <ActivityAxisBody
      bucketMs={10 * 60_000}
      lanes={lanes}
      lines={lines}
      onPin={() => {}}
      pin={undefined}
      timeZone="UTC"
      window={{ from: NOW - DAY, to: NOW }}
    />,
    { path: '/activity', routePaths: ['/activity', '/systems/$name'] },
  );

test('the unpaired Systems lanes sit greyed below a divider, after the paired ones', async () => {
  const html = await renderAxis([lane('server-1', false), lane('build-2', true)]);
  expect(html.match(/Unpaired, history kept/gu)).toHaveLength(1);
  const divider = html.indexOf('Unpaired, history kept');
  const paired = html.slice(0, divider);
  const greyed = html.slice(divider);
  expect(paired).toContain('href="/systems/server-1"');
  expect(paired).not.toContain('href="/systems/build-2"');
  expect(greyed).toMatch(
    /class="text-muted-foreground saturate-50[^"]*">.*href="\/systems\/build-2"/u,
  );
  expect(greyed).not.toContain('href="/systems/server-1"');
});

test('with every System paired there is no divider and no lane is greyed', async () => {
  const html = await renderAxis([lane('server-1', false), lane('laptop-1', false)]);
  expect(html).not.toContain('Unpaired, history kept');
  expect(html).not.toContain('saturate-50');
});

test('a change mark sits in the strip above the plot, so it never covers a scale label', async () => {
  const line: ActivityLine = {
    at: NOW - 60 * 60_000,
    events: [
      { at: NOW - 60 * 60_000, kind: 'stop', ongoing: false, service: 'caddy', system: 'server-1' },
    ],
    system: 'server-1',
  };
  const html = await renderAxis([lane('server-1', false)], [line]);
  const strip = /data-marks-strip="true">(.*?)<\/div>/u.exec(html)?.[1] ?? '';
  expect(strip).toContain('<button');
  expect(html.replace(strip, '')).not.toContain('<button');
});
