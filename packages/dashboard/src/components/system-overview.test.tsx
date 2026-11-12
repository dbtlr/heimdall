import { expect, test } from 'bun:test';

import type { SystemDetail } from '../server/system-detail-types.ts';
import { renderRouted } from './render-routed.tsx';
import { SystemOverview } from './system-overview.tsx';

const GIB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const FROM = NOW - 6 * 3_600_000;

const detail = (limitPercent: SystemDetail['limitPercent']): SystemDetail => ({
  changes: [],
  collectorVersion: '1.0.0',
  conditions: [],
  cpu: [{ average: 20, high: 30, low: 10, t: NOW - 300_000 }],
  from: FROM,
  gaps: [],
  harnesses: [],
  lastSeenAt: NOW,
  latest: {
    cpuBusyPercent: 20,
    disks: [],
    load: [1, 1, 1],
    memoryTotalBytes: 10 * GIB,
    memoryUsedBytes: 4 * GIB,
    t: NOW,
    uptimeSeconds: 3_600,
  },
  limitPercent,
  load: [{ t: NOW - 300_000, value: 1 }],
  memory: [{ t: NOW - 300_000, totalBytes: 10 * GIB, usedBytes: 4 * GIB }],
  name: 'server-1',
  now: NOW,
  paired: true,
  platform: { arch: 'x64', os: 'linux' },
  processes: [],
  range: '6h',
  sessions: [],
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  to: NOW,
});

const render = (limitPercent: SystemDetail['limitPercent']) =>
  renderRouted(
    <SystemOverview
      attention={[]}
      detail={detail(limitPercent)}
      failed={false}
      loading={false}
      onSelect={() => {}}
      recorded={{ applications: [], files: [], jobs: [], services: [] }}
      sample={null}
    />,
  );

// The limit lines' values, in the order the charts draw them.
const limitLines = (html: string) =>
  [...html.matchAll(/data-limit="([^"]*)"/gu)].map(([, value]) => Number(value));

test('draws and names the CPU and memory limits the Hub judges this System by', async () => {
  const html = await render({ cpu: 60, memory: 70 });

  // CPU at 60% of its scale; memory at 70% of the System's 10 GiB.
  expect(limitLines(html)).toEqual([60, 7]);
  expect(html).toContain('60% limit');
  expect(html).toContain('70% limit');
  expect(html).toContain('limit 60%');
  expect(html).toContain('limit 70%');
});

test('draws and names no limit while the Hub has stored none', async () => {
  const html = await render(undefined);

  expect(limitLines(html)).toEqual([]);
  expect(html).not.toContain('% limit');
  expect(html).not.toContain('limit ');
});
