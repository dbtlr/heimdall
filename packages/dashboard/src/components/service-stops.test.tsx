import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ServiceDetail } from '../server/service-detail-types.ts';
import { renderRouted } from './render-routed.tsx';
import { AvailabilityCard, AvailabilityStrip } from './service-stops.tsx';

// Saturday 24 Oct 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 24, 12, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The Service was first seen 10 days ago, at 12:00 on 14 Oct; it was down for
// an hour 2 hours ago, and once 20 days ago, before it was first seen. The
// System sent no Vitals on 20 Oct.
const QUIET_DAY = Date.UTC(2026, 9, 20);
const detail = (over: Partial<ServiceDetail> = {}): ServiceDetail => ({
  downs: [
    { at: NOW - 20 * DAY, condition: '1', kind: 'raised', reason: 'Stopped' },
    { at: NOW - 20 * DAY + HOUR, condition: '1', kind: 'cleared', reason: 'Stopped' },
    { at: NOW - 2 * HOUR, condition: '2', kind: 'raised', reason: 'Stopped' },
    { at: NOW - HOUR, condition: '2', kind: 'cleared', reason: 'Stopped' },
  ],
  existedSince: NOW - 10 * DAY,
  installed: { missingApplication: undefined, upstream: null, version: null },
  installs: [],
  note: undefined,
  now: NOW,
  recorded: undefined,
  reported: [
    { from: NOW - 91 * DAY, to: QUIET_DAY },
    { from: QUIET_DAY + DAY, to: NOW },
  ],
  selection: undefined,
  service: 'web',
  stops: [],
  system: 'server-1',
  unit: undefined,
  update: { failure: undefined, status: undefined },
  updates: [],
  ...over,
});

// Each cell of the strip, as its class and its title.
const cells = (found: ServiceDetail) =>
  [
    ...renderToStaticMarkup(<AvailabilityStrip detail={found} timeZone="UTC" />).matchAll(
      /<span class="([^"]*)"[^>]*title="([^"]*)"/gu,
    ),
  ].map(([, className = '', title = '']) => ({ className, title }));

test('the strip shows each day before the Service was first seen as not seen yet', () => {
  const found = cells(detail());
  expect(found).toHaveLength(90);
  // 27 Jul to 13 Oct ended before 12:00 on 14 Oct.
  const unseen = found.filter(({ title }) => title.endsWith(': not seen yet'));
  expect(unseen).toHaveLength(79);
  expect(found.slice(0, 79)).toEqual(unseen);
  // Even the day it was down, before it was first seen.
  expect(found.some(({ title }) => title.endsWith(': down'))).toBe(true);
  expect(found.filter(({ title }) => title.endsWith(': down'))).toHaveLength(1);
  expect(
    cells(detail({ existedSince: undefined })).some(({ title }) => title.endsWith('yet')),
  ).toBe(false);
});

test('a day not seen yet looks unlike a day with no Reports', () => {
  const found = cells(detail());
  const unseen = found.find(({ title }) => title.endsWith(': not seen yet'))?.className ?? '';
  const quiet = found.find(({ title }) => title.endsWith(': no Reports'))?.className ?? '';
  expect(quiet).toContain('bg-muted');
  expect(unseen).not.toContain('bg-muted');
  expect(unseen).not.toBe(quiet);
});

test('the percentage and the counts cover only the time since the Service was first seen', async () => {
  const words = (await renderRouted(<AvailabilityCard detail={detail()} />))
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
  // Down 1 hour of the 9 days with Reports since it was first seen, not of 89.
  expect(words).toContain('99.53% 1 down period, 0 other stops');
  expect(words).toContain('the percentage covers the time since the Service was first seen');
  const unbounded = (
    await renderRouted(<AvailabilityCard detail={detail({ existedSince: undefined })} />)
  )
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
  expect(unbounded).toContain('2 down periods');
});
