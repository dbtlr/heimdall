import { expect, test } from 'bun:test';

import type { Recorded, SystemDetail } from '../server/system-detail-types.ts';
import { DetailAxis, SampleSlider } from './detail-track.tsx';
import { renderRouted } from './render-routed.tsx';
import { SystemOverview } from './system-overview.tsx';

const GIB = 1024 ** 3;
const BANDS = { alert: 90, note: 70, warning: 80 };
const NOW = 1_800_000_000_000;
const FROM = NOW - 6 * 3_600_000;

const detail = (
  limitPercent: SystemDetail['limitPercent'],
  overrides: Partial<SystemDetail> = {},
): SystemDetail => ({
  changes: [],
  collectorVersion: '1.0.0',
  conditions: [],
  cpu: [{ average: 20, high: 30, low: 10, t: NOW - 300_000 }],
  diskTrends: [],
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
  ...overrides,
});

const render = (
  limitPercent: SystemDetail['limitPercent'],
  overrides: Partial<SystemDetail> = {},
  services: Recorded['services'] = [],
) =>
  renderRouted(
    <SystemOverview
      at={undefined}
      attention={[]}
      detail={detail(limitPercent, overrides)}
      failed={false}
      loading={false}
      onSelect={() => {}}
      recorded={{ applications: [], files: [], jobs: [], services }}
      sample={null}
    />,
  );

// The limit lines' values, in the order the charts draw them.
const limitLines = (html: string) =>
  [...html.matchAll(/data-limit="([^"]*)"/gu)].map(([, value]) => Number(value));

test('draws and names the CPU and memory limits the Hub judges this System by', async () => {
  const html = await render({ cpu: 60, disk: BANDS, memory: 70 });

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

test("draws the memory limit at its share of the System's own memory when that is under the scale's 1 GiB floor", async () => {
  const MIB = 1024 ** 2;
  const html = await render(
    { cpu: 60, disk: BANDS, memory: 80 },
    { memory: [{ t: NOW - 300_000, totalBytes: 512 * MIB, usedBytes: 256 * MIB }] },
  );

  // 80% of 512 MiB is 0.4 GiB, not 80% of the 1 GiB scale.
  expect(limitLines(html)).toEqual([60, 0.4]);
});

// A Harness process that kept `cores` busy in the window's last bucket.
const harnessProcess = (processId: number, cores: number) => ({
  harness: 'claude-code',
  pid: processId,
  points: [{ cores, t: NOW - 300_000 }],
  processId,
  project: undefined,
});

test('keeps the Harness process plots in a closed disclosure under the Session lanes, with idle processes folded', async () => {
  const html = await render(undefined, {
    processes: [harnessProcess(1, 0.5), harnessProcess(2, 0)],
  });
  const [, disclosure = ''] = html.split('aria-label="Agent Sessions"');

  expect(disclosure).toMatch(/<details[^>]*><summary[^>]*>Harness processes/u);
  expect(disclosure).not.toMatch(/<details[^>]*\bopen\b[^>]*><summary[^>]*>Harness processes/u);
  expect(disclosure).toContain('aria-label="CPU cores per Harness process"');
  expect(disclosure).toContain('1 idle process in this range');
});

// The opening tag of the element carrying `marker`, such as `role="slider"`.
const tagWith = (html: string, marker: string): string =>
  new RegExp(`<[a-z]+ [^>]*${marker}[^>]*>`, 'u').exec(html)?.[0] ?? '';

test('the time slider draws a focus ring when the keyboard reaches it', async () => {
  const html = await render(undefined);

  expect(tagWith(html, 'role="slider"')).toContain('focus-visible:outline-2');
});

// The markup of the Harness processes disclosure, from its summary on.
const harnessDisclosure = async (processes: SystemDetail['processes']) => {
  const html = await render(undefined, { processes });
  const [, disclosure = ''] = html.split(/<summary[^>]*>Harness processes<\/summary>/u);
  return disclosure;
};

test('the Harness process plots keep the gutter of the charts above and draw their scale in it', async () => {
  const disclosure = await harnessDisclosure([harnessProcess(1, 0.5)]);

  expect(tagWith(disclosure, 'aria-label="Harness processes"')).toContain('pl-14');
  expect(tagWith(disclosure, 'data-scale-tick="0"')).toContain('right-full');
});

test('the Harness processes disclosure grows to hold its plots rather than scrolling them', async () => {
  const disclosure = await harnessDisclosure([harnessProcess(1, 0.5)]);

  expect(disclosure).toMatch(/^<div class="[^"]*"/u);
  expect(disclosure).not.toMatch(/^<div class="[^"]*overflow-y-auto/u);
});

test('leaves out the Harness processes disclosure when the System ran none in the window', async () => {
  const html = await render(undefined, { processes: [] });

  expect(html).not.toContain('Harness processes');
});

// The slider's aria-valuenow in `html`.
const sliderValue = (html: string) =>
  /aria-valuenow="(\d+)"/u.exec(tagWith(html, 'role="slider"'))?.[1];

// The slider alone over the 6 h window, with `at` pinned.
const renderSlider = (at: number) =>
  renderRouted(
    <DetailAxis
      at={at}
      onSelect={() => undefined}
      selected={undefined}
      window={{ from: FROM, to: NOW }}
    >
      <SampleSlider>axis</SampleSlider>
    </DetailAxis>,
  );

test('the time slider stands at the window edge when the pinned time lies outside it, as after a range change', async () => {
  expect(sliderValue(await renderSlider(FROM - 3 * 3_600_000))).toBe(String(FROM));
  expect(sliderValue(await renderSlider(NOW + 3_600_000))).toBe(String(NOW));
});

const service = (name: string, version: string | null, update: string | undefined) => ({
  checks: [],
  name,
  supervisor: 'systemd',
  update,
  version,
});

test('lists each Service with its installed version and the update on offer, counting the updates', async () => {
  const html = await render(undefined, {}, [
    service('caddy', '2.10.2', '2.10.3'),
    service('redis', '8.2.1', undefined),
    service('cron', null, undefined),
  ]);

  expect(html).toContain('3 · 1 update');
  expect(html).toContain('2.10.2');
  expect(html).toContain('8.2.1');
  expect(html.match(/data-update="[^"]*"/gu)).toEqual(['data-update="2.10.3"']);
});

test('reads a Service whose installed version is unknown as a muted "unknown", as the Services page does', async () => {
  const html = await render(undefined, {}, [service('cron', null, undefined)]);
  const [, rail = ''] = html.split('id="rail-services"');

  expect(rail).toContain('<span class="text-muted-foreground">unknown</span>');
});
