import { describe, expect, test } from 'bun:test';

import type { ActivityLine } from '../lib/activity.ts';
import type { AxisLane } from '../server/activity-types.ts';
import { ActivityAxis, ActivityAxisBody, trackPointer } from './activity-axis.tsx';
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

// The inline style of each element carrying `marker`, as property to pixels.
const stylesOf = (html: string, marker: string): Record<string, number>[] =>
  [...html.matchAll(new RegExp(`<[a-z0-9]+ [^>]*${marker}[^>]*>`, 'gu'))].map(([tag]) =>
    Object.fromEntries(
      (/style="([^"]*)"/u.exec(tag)?.[1] ?? '')
        .split(';')
        .filter(Boolean)
        .map((rule) => {
          const [property = '', value = ''] = rule.split(':');
          return [property, Number.parseFloat(value)];
        }),
    ),
  );

const one = (html: string, marker: string): Record<string, number> => {
  const found = stylesOf(html, marker);
  expect(found).toHaveLength(1);
  return found[0] ?? {};
};

const px = (style: Record<string, number>, name: string): number => {
  const value = style[name];
  expect(value).toBeNumber();
  return value ?? Number.NaN;
};

// The height the rendered axis takes on a phone and from sm up, added up from
// the sizes its own markup gives each part: every lane's border, padding,
// marks strip, plot, and stretches strip, the phone's stacked label and the
// gap under it, the divider when it shows, the time axis, and the legend's first line.
const renderedHeight = (html: string) => {
  const lanes = stylesOf(html, 'data-lane="true"');
  const marks = stylesOf(html, 'data-marks-strip="true"');
  const plots = stylesOf(html, 'class="relative w-full"');
  const stretches = stylesOf(html, 'data-stretches="true"');
  const labels = stylesOf(html, 'data-lane-label="true"');
  expect([marks, plots, stretches, labels].map((found) => found.length)).toEqual(
    Array.from({ length: 4 }, () => lanes.length),
  );
  const wide = lanes.reduce(
    (total, style, index) =>
      total +
      px(style, 'border-top-width') +
      2 * px(style, 'padding-block') +
      px(marks[index] ?? {}, 'height') +
      px(plots[index] ?? {}, 'height') +
      px(stretches[index] ?? {}, 'height'),
    0,
  );
  const phoneLabels = lanes.reduce(
    (total, style, index) => total + px(labels[index] ?? {}, 'line-height') + px(style, 'row-gap'),
    0,
  );
  const dividers = stylesOf(html, 'data-unpaired-divider="true"').reduce(
    (total, divider) => total + px(divider, 'margin-top') + px(divider, 'line-height'),
    0,
  );
  const axis = one(html, 'data-time-axis="true"');
  const ticks = one(html, 'data-time-axis-ticks="true"');
  const legend = one(html, 'data-axis-legend="true"');
  const below =
    px(axis, 'padding-top') +
    px(ticks, 'height') +
    px(legend, 'padding-top') +
    px(legend, 'line-height');
  return { phone: wide + phoneLabels + dividers + below, wide: wide + dividers + below };
};

const placeholderHeight = async (lanes: readonly AxisLane[]) => {
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
  return {
    phone: px(one(html, 'class="sm:hidden"'), 'height'),
    wide: px(one(html, 'class="max-sm:hidden"'), 'height'),
  };
};

describe('the placeholder before the time zone is known', () => {
  const cases: [string, AxisLane[]][] = [
    ['paired lanes', [lane('server-1', false), lane('laptop-1', false), lane('build-2', false)]],
    [
      'paired and unpaired lanes',
      [lane('server-1', false), lane('laptop-1', false), lane('old-1', true), lane('old-2', true)],
    ],
    ['only unpaired lanes', [lane('old-1', true)]],
    ['no lanes', []],
  ];
  for (const [what, lanes] of cases) {
    test(`holds the room the axis takes with ${what}, on a phone and from sm up`, async () => {
      const rendered = renderedHeight(await renderAxis(lanes));
      expect(await placeholderHeight(lanes)).toEqual(rendered);
    });
  }

  test('a lane has a border only below another lane of its group', async () => {
    const html = await renderAxis([
      lane('server-1', false),
      lane('laptop-1', false),
      lane('old-1', true),
      lane('old-2', true),
    ]);
    expect(stylesOf(html, 'data-lane="true"').map((style) => style['border-top-width'])).toEqual([
      0, 1, 0, 1,
    ]);
  });
});

test('a change mark keeps its 16 px glyph and gains a 24 px hit area centered on it', async () => {
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
  const button = (/<button[^>]*class="([^"]*)"/u.exec(html)?.[1] ?? '')
    .replaceAll('&#x27;', "'")
    .split(' ');
  expect(button).toContain('size-4');
  // The hit area is a pseudo-element, so it must have content to exist; it is
  // taken out of the flow, so it adds no height to the strip, and centered on
  // the glyph by its top-left corner at the middle, pulled back by half its size.
  expect(button).toEqual(
    expect.arrayContaining([
      "before:content-['']",
      'before:absolute',
      'before:size-6',
      'before:top-1/2',
      'before:left-1/2',
      'before:-translate-x-1/2',
      'before:-translate-y-1/2',
    ]),
  );
});
