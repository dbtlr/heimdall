import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Attention } from '../server/attention-types.ts';
import { SystemNowCards } from './system-now-cards.tsx';

const GIB = 1024 ** 3;
const NOW = 10 * 60_000;

const lowDisk: Attention = {
  checkedAt: 0,
  conditionId: 'c-disk',
  disk: undefined,
  evidence: 'current',
  firstDetected: 0,
  kind: 'low_disk',
  level: 'alert',
  reason: '91% used',
  subject: '/data',
  system: 'gateway-1',
  unpaired: false,
};

type Detail = Parameters<typeof SystemNowCards>[0]['detail'];

const baseLatest = {
  cpuBusyPercent: 23.4,
  disks: [
    { mount: '/', totalBytes: 100 * GIB, usedBytes: 50 * GIB },
    { mount: '/data', totalBytes: 100 * GIB, usedBytes: 91 * GIB },
  ],
  load: [1.5, 1.25, 0.5] as [number, number, number],
  memoryTotalBytes: 16 * GIB,
  memoryUsedBytes: 8 * GIB,
  t: NOW - 30_000,
  uptimeSeconds: 86400,
};

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  cpu: [
    { average: 10, high: 20, low: 5, t: 0 },
    { average: 20, high: 31, low: 10, t: 300_000 },
  ],
  gaps: [],
  latest: baseLatest,
  memory: [
    { t: 0, totalBytes: 16 * GIB, usedBytes: 4 * GIB },
    { t: 300_000, totalBytes: 16 * GIB, usedBytes: 8 * GIB },
  ],
  now: NOW,
  range: '12h',
  ...overrides,
});

test('the four cards show CPU with its range high, memory, the disk, and load', () => {
  const html = renderToStaticMarkup(<SystemNowCards detail={detail()} items={[]} />);
  expect(html).toContain('hidden lg:grid lg:grid-cols-4');
  expect(html).toContain('23%');
  expect(html).toContain('12 h high 31%');
  expect(html).toContain('8.0');
  expect(html).toContain('of 16.0 GiB');
  expect(html).toContain('aria-label="Disk /data 91%"');
  expect(html).toContain('1.50');
  expect(html).toContain('5-min 1.25 · 15-min 0.50');
  expect((html.match(/<path /gu) ?? []).length).toBe(2);
});

test('the disk card names the low-disk mount and takes its Condition level color', () => {
  const html = renderToStaticMarkup(<SystemNowCards detail={detail()} items={[lowDisk]} />);
  expect(html).toContain('disk /data');
  expect(html).toContain('text-[color-mix(in_srgb,var(--status-critical)_65%,white)]');
});

test('Vitals older than the quiet limit are muted and dated for screen readers', () => {
  const html = renderToStaticMarkup(
    <SystemNowCards detail={detail({ now: NOW + 10 * 60_000 })} items={[]} />,
  );
  expect(html).toContain('opacity-50');
  expect(html).toContain('Vitals as of 10 min ago');
  expect(renderToStaticMarkup(<SystemNowCards detail={detail()} items={[]} />)).not.toContain(
    'opacity-50',
  );
});

test('an unknown load reads as a dash', () => {
  const html = renderToStaticMarkup(
    <SystemNowCards
      detail={detail({
        latest: { ...baseLatest, load: [Number.NaN, Number.NaN, Number.NaN] },
      })}
      items={[]}
    />,
  );
  expect(html).toContain('aria-label="Load unknown"');
  expect(html).toContain('>—<');
});

test('a System without Vitals says so instead of drawing cards', () => {
  const html = renderToStaticMarkup(
    <SystemNowCards detail={detail({ latest: undefined })} items={[]} />,
  );
  expect(html).toContain('No Vitals sample has arrived.');
  expect(html).not.toContain('<svg');
});
