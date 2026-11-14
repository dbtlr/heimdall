import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';
import { renderToStaticMarkup } from 'react-dom/server';

import { diskForecast, forecastWords } from '../lib/disk-forecast.ts';
import { readSystemPage } from '../server/system-detail.ts';
import { SystemDisks, SystemFacts } from './system-facts.tsx';

beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

test('a clock rollback keeps an open alert in the page and its disk bar', async () => {
  await using h = await startHub();
  const body = report('server-1', [NOW]);
  body.samples = body.samples.map((sample) => ({
    ...sample,
    disks: [{ mount: '/', totalBytes: 100, usedBytes: 99 }],
  }));
  await push(h.hub, body, { token: 'server-token' });
  await timeline(NOW).addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'alert',
    raisedAt: 60,
    subject: '/',
    system: 'server-1',
  });

  const page = await readSystemPage(h.db.sql, { name: 'server-1', now: NOW, range: '12h' });
  if (page === undefined) {
    throw new Error('The reported System must have a page.');
  }
  expect(page.detail.status).toBe('needs_you');
  expect(page.detail.conditions).toMatchObject([{ level: 'alert', raisedAt: NOW + 60_000 }]);
  expect(page.attention[0]?.level).toBe('alert');
  expect(renderToStaticMarkup(<SystemFacts detail={page.detail} />)).toContain(
    'bg-status-critical',
  );
});

test('disk bars use the stored Hub level instead of inferring urgency from disk use', () => {
  const html = renderToStaticMarkup(
    <SystemFacts
      detail={{
        conditions: [
          {
            clearedAt: undefined,
            id: '1',
            kind: 'low_disk',
            level: 'note',
            raisedAt: 0,
            subject: '/',
            transitions: [],
          },
        ],
        diskTrends: [],
        harnesses: undefined,
        latest: {
          cpuBusyPercent: 1,
          disks: [{ mount: '/', totalBytes: 100, usedBytes: 99 }],
          load: [0, 0, 0],
          memoryTotalBytes: 100,
          memoryUsedBytes: 1,
          t: 0,
          uptimeSeconds: 100,
        },
        limitPercent: undefined,
        now: 0,
      }}
    />,
  );
  expect(html).toContain('bg-status-warning');
  expect(html).not.toContain('bg-status-serious');
});

const GIB = 1024 ** 3;
const BANDS = { alert: 90, note: 70, warning: 80 };
const ROOT = { mount: '/', totalBytes: 100 * GIB, usedBytes: 74 * GIB };
const DATA = { mount: '/data', totalBytes: 100 * GIB, usedBytes: 10 * GIB };

const disksDetail = ({ bands }: { bands: boolean }) => ({
  conditions: [],
  diskTrends: [
    { growth: { bytesPerDay: 5 * GIB }, mount: '/data' },
    { growth: { bytesPerDay: 2 * GIB }, mount: '/' },
  ],
  latest: {
    cpuBusyPercent: 1,
    disks: [ROOT, DATA],
    load: [0, 0, 0] as [number, number, number],
    memoryTotalBytes: 100,
    memoryUsedBytes: 1,
    t: 0,
    uptimeSeconds: 100,
  },
  limitPercent: bands ? { cpu: 90, disk: BANDS, memory: 90 } : undefined,
  now: 0,
});

test("each disk draws the Hub's bands as ticks and forecasts from its own mount's growth", () => {
  const html = renderToStaticMarkup(<SystemDisks detail={disksDetail({ bands: true })} />);
  expect([...html.matchAll(/data-band="(\d+)"/gu)].map(([, band]) => band)).toEqual([
    '70',
    '80',
    '90',
    '70',
    '80',
    '90',
  ]);
  for (const [disk, bytesPerDay] of [
    [ROOT, 2 * GIB],
    [DATA, 5 * GIB],
  ] as const) {
    expect(html).toContain(
      forecastWords(diskForecast({ bands: BANDS, disk, growth: { bytesPerDay } })),
    );
  }
});

test('a disk draws no ticks while the Hub has stored no bands', () => {
  expect(
    renderToStaticMarkup(<SystemDisks detail={disksDetail({ bands: false })} />),
  ).not.toContain('data-band');
});
