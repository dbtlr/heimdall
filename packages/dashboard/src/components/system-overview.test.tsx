import { expect, test } from 'bun:test';

import type { BucketInspection, Recorded, SystemDetail } from '../server/system-detail-types.ts';
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
  bucketMs: 300_000,
  changes: [],
  collectorVersion: '1.0.0',
  conditions: [],
  cpu: [{ average: 20, high: 30, low: 10, t: NOW - 300_000 }],
  cpuCores: undefined,
  diskTrends: [],
  edges: undefined,
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
  load: [{ high: 1, low: 1, t: NOW - 300_000, value: 1 }],
  long: undefined,
  memory: [
    {
      highBytes: 4 * GIB,
      lowBytes: 4 * GIB,
      t: NOW - 300_000,
      totalBytes: 10 * GIB,
      usedBytes: 4 * GIB,
    },
  ],
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
  bucket: BucketInspection | null = null,
) =>
  renderRouted(
    <SystemOverview
      at={undefined}
      attention={[]}
      bucket={bucket}
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
    {
      memory: [
        {
          highBytes: 256 * MIB,
          lowBytes: 256 * MIB,
          t: NOW - 300_000,
          totalBytes: 512 * MIB,
          usedBytes: 256 * MIB,
        },
      ],
    },
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

  expect(tagWith(disclosure, 'aria-label="Harness processes"')).toContain(
    'pl-[var(--chart-gutter,3.5rem)]',
  );
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

test('names known logical cores and draws their dashed load limit within the scale', async () => {
  const html = await render(undefined, { cpuCores: 8 });
  expect(html).toContain('aria-label="Load (1 min)"');
  expect(html).toContain('8 cores now');
  expect(html).not.toContain('Load (1 min) ·');
  expect(html).toContain('border-color:var(--muted-foreground)');
  expect(limitLines(html)).toEqual([8]);
  expect(html).toContain('8 cores');
  expect(html).toContain('border-dashed');
  expect(html).toContain('data-scale-tick="8"');
  const unknown = await render(undefined);
  expect(unknown).toContain('Load (1 min)');
  expect(unknown).not.toContain('Load (1 min) ·');
  expect(limitLines(unknown)).toEqual([]);
});

test('names one current core in the load note and reference line', async () => {
  const html = await render(undefined, { cpuCores: 1 });
  expect(html.match(/1 core now/gu)).toHaveLength(2);
  expect(html).toContain('aria-label="Load (1 min)"');
});

const DAY = 24 * 3_600_000;

// UTC days from the one holding `from` through the one after now.
const dayEdges = (from: number) => {
  const edges: number[] = [];
  for (let t = Math.floor(from / DAY) * DAY; t <= NOW + DAY; t += DAY) {
    edges.push(t);
  }
  return edges;
};

// Where each change diamond sits along the lane, in percent.
const diamonds = (html: string) =>
  [...html.matchAll(/left:([0-9.]+)%"[^>]*title="[0-9]+ changes?"/gu)].map(([, left]) =>
    Number(left),
  );

test('over 30 days, the change diamonds of the first and the current day stay on the chart', async () => {
  const from = NOW - 30 * DAY;
  const days = dayEdges(from);
  const html = await render(undefined, {
    bucketMs: 3 * 3_600_000,
    changes: [
      {
        at: from + 3_600_000,
        from: '1',
        kind: 'version',
        service: 'web',
        system: 'server-1',
        to: '2',
      },
      {
        at: NOW - 3_600_000,
        from: '2',
        kind: 'version',
        service: 'web',
        system: 'server-1',
        to: '3',
      },
    ],
    edges: days,
    from,
    long: {
      changeEdges: days,
      costs: [],
      dayEdges: days,
      reboots: [from - 3_600_000],
      sessions: 0,
    },
    range: '30d',
  });

  const today = days.findLast((edge) => edge <= NOW) ?? NOW;
  const first = days[1] ?? NOW;
  const percent = (t: number) => ((t - from) / (NOW - from)) * 100;
  const [early, late] = diamonds(html);
  expect(early).toBeCloseTo(percent((from + first) / 2), 6);
  expect(late).toBeCloseTo(percent((today + NOW) / 2), 6);
  expect(late).toBeLessThan(100);
  // A reboot in the first bucket, before the range starts, stands at its start.
  expect(html).toMatch(/left:0%"[^>]*title="Rebooted"/u);
});

test('over a year: day buckets with bands, cost bars, Conditions folded by kind, and the bucket inspector', async () => {
  const year = NOW - 365 * DAY;
  const html = await render(
    { cpu: 90, disk: BANDS, memory: 80 },
    {
      bucketMs: DAY,
      conditions: [1, 2].map((n) => ({
        clearedAt: NOW - n * 10 * DAY + 3_600_000,
        id: String(n),
        kind: 'high_cpu' as const,
        level: 'warning' as const,
        raisedAt: NOW - n * 10 * DAY,
        subject: '',
        transitions: [],
      })),
      cpuCores: 8,
      edges: dayEdges(year),
      from: year,
      long: {
        changeEdges: [],
        costs: [{ costUsd: 12, harness: 'claude-code', t: NOW - 3 * DAY, unpriced: 0 }],
        dayEdges: dayEdges(year),
        reboots: [NOW - 40 * DAY],
        sessions: 1214,
      },
      range: '1y',
    },
    [],
    {
      bucketMs: DAY,
      conditions: [],
      costUsd: 12,
      cpu: { average: 20, high: 90, low: 2 },
      day: undefined,
      end: NOW - 19 * DAY,
      load1: { average: 1, high: 2, low: 0 },
      memory: { average: 4 * GIB, high: 5 * GIB, low: 3 * GIB, totalBytes: 10 * GIB },
      processes: [],
      rebootedAt: undefined,
      rollups: 288,
      samplesPruned: true,
      sessions: 3,
      t: NOW - 20 * DAY,
      unpricedRequests: 0,
    },
  );

  for (const text of [
    'average, low–high band · 1-day buckets · limit 90%',
    'list-price cost per day · 1,214 Sessions in the year',
    'aria-label="Agent cost per bucket"',
    'one row per kind · changes per week',
    'High CPU 2×',
    'Reboots',
    'One 1-day bucket: 288 five-minute rollups',
    'not kept past 14 d',
    '--chart-gutter:7rem',
  ]) {
    expect(html).toContain(text);
  }
  // Load is the 1-minute load, banded like the others, with the core count.
  expect(html).toContain('8 cores now · average, low–high band');
  expect(limitLines(html)).toContain(8);
});
