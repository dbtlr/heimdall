import { expect, test } from 'bun:test';

import type { ActivityLine } from '../lib/activity.ts';
import type { AxisLane } from '../server/activity-types.ts';
import {
  ActivityAxis,
  ActivityAxisBody,
  LANE_BORDER,
  LANE_PADDING,
  LANE_PLOT_HEIGHT,
  MARK_HIT_PX,
  MARKS_STRIP_HEIGHT,
  PHONE_LABEL_ROW,
  STRETCHES_STRIP_HEIGHT,
  trackPointer,
} from './activity-axis.tsx';
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
      {
        at: NOW - 60 * 60_000,
        kind: 'stop',
        lasted: 60_000,
        ongoing: false,
        restarts: 0,
        service: 'caddy',
        system: 'server-1',
      },
    ],
    system: 'server-1',
  };
  const html = await renderAxis([lane('server-1', false)], [line]);
  const strip = /data-marks-strip="true"[^>]*>(.*?)<\/div>/u.exec(html)?.[1] ?? '';
  expect(strip).toContain('<button');
  expect(html.replace(strip, '')).not.toContain('<button');
});

test('the placeholder before the time zone is known holds the room the lanes take, on a phone and from sm up', async () => {
  const lanes = [lane('server-1', false), lane('laptop-1', false), lane('build-2', false)];
  const html = await renderRouted(
    <ActivityAxis
      bucketMs={10 * 60_000}
      lanes={lanes}
      lines={[]}
      onPin={() => {}}
      pin={undefined}
      window={{ from: NOW - DAY, to: NOW }}
    />,
    { path: '/activity', routePaths: ['/activity', '/systems/$name'] },
  );
  const track = MARKS_STRIP_HEIGHT + LANE_PLOT_HEIGHT + STRETCHES_STRIP_HEIGHT;
  // A lane is its track and padding; every lane but the first has a border.
  const wide = lanes.length * (track + LANE_PADDING) + (lanes.length - 1) * LANE_BORDER;
  const phone = wide + lanes.length * PHONE_LABEL_ROW;
  expect(html).toMatch(new RegExp(`class="max-sm:hidden" style="height:${String(wide)}px"`, 'u'));
  expect(html).toMatch(new RegExp(`class="sm:hidden" style="height:${String(phone)}px"`, 'u'));
  // The phone's stacked label row is a text-xs line and the grid's gap-1.5.
  expect(PHONE_LABEL_ROW).toBe(16 + 6);
});

test('a change mark keeps its 16 px glyph and gains a 24 px hit area that adds no height', async () => {
  const line: ActivityLine = {
    at: NOW - 60 * 60_000,
    events: [
      {
        at: NOW - 60 * 60_000,
        kind: 'stop',
        lasted: 60_000,
        ongoing: false,
        restarts: 0,
        service: 'caddy',
        system: 'server-1',
      },
    ],
    system: 'server-1',
  };
  const html = await renderAxis([lane('server-1', false)], [line]);
  const button = /<button[^>]*class="([^"]*)"/u.exec(html)?.[1] ?? '';
  expect(MARK_HIT_PX).toBe(24);
  expect(button).toContain('size-4');
  expect(button).toContain('before:size-6');
  expect(button).toContain('before:absolute');
  expect(MARKS_STRIP_HEIGHT).toBe(16);
});
