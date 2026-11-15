import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { BucketInspection } from '../server/system-detail-types.ts';
import { BucketInspector } from './bucket-inspector.tsx';

const DAY = 24 * 3_600_000;
const T = Date.UTC(2026, 7, 12);
const GIB = 1024 ** 3;

const day: BucketInspection = {
  bucketMs: DAY,
  conditions: [{ kind: 'low_disk', level: 'note', subject: '/data' }],
  costUsd: 27.4,
  cpu: { average: 21.2, high: 94, low: 2 },
  day: undefined,
  end: T + DAY,
  load1: { average: 1.7, high: 7.9, low: 0.2 },
  memory: { average: 17.1 * GIB, high: 19.6 * GIB, low: 12 * GIB, totalBytes: 32 * GIB },
  processes: [
    {
      cpuHours: 1.94,
      harness: 'claude-code',
      peakRssBytes: 1.4 * GIB,
      pid: 4121,
      processId: 1,
      project: 'heimdall',
      sessions: 5,
    },
  ],
  rebootedAt: T + 3 * 3_600_000 + 10 * 60_000,
  rollups: 288,
  samplesPruned: true,
  sessions: 9,
  t: T,
  unpricedRequests: 0,
};

const render = (bucket: BucketInspection | null, loading = false) =>
  renderToStaticMarkup(<BucketInspector bucket={bucket} failed={false} loading={loading} />);

test("inspects a bucket's averages, lows, and highs, its cost, processes, and Conditions", () => {
  const html = render(day);
  for (const text of [
    'One 1-day bucket: 288 five-minute rollups',
    'avg 21%',
    'low 2, high 94',
    'avg 17.1 / 32.0 GiB',
    'high 19.6 GiB',
    'avg 1.7',
    'high 7.9',
    'Rebooted',
    '$27.40',
    '9 Sessions working that day',
    'heimdall',
    'pid 4121',
    '1.9 CPU-hours, peak 1.4 GiB · 5 Sessions',
    'Low disk',
    '/data',
    'Select any point on the axis to inspect its bucket.',
  ]) {
    expect(html).toContain(text);
  }
});

test('says top CPU processes and memory holders are not kept for a bucket older than 14 days', () => {
  expect(render(day)).toContain('Top CPU processes and memory holders');
  expect(render(day)).toContain('not kept past 14 d');
  expect(render({ ...day, samplesPruned: false })).not.toContain('not kept past 14 d');
});

test('names a 3-hour bucket, and a bucket with no Vitals', () => {
  const html = render({
    ...day,
    bucketMs: 3 * 3_600_000,
    conditions: [],
    cpu: undefined,
    load1: undefined,
    memory: undefined,
    processes: [],
    rebootedAt: undefined,
    rollups: 0,
    sessions: 0,
  });
  expect(html).toContain('One 3-hour bucket: no Vitals');
  expect(html).not.toContain('Rebooted');
  expect(html).toContain('No Harness process');
});

test("names the cost of a 3-hour bucket and, beside it, its day's, which the cost bar shows", () => {
  const html = render({
    ...day,
    bucketMs: 3 * 3_600_000,
    costUsd: 4,
    day: { costUsd: 27.4, end: T + DAY, start: T, unpricedRequests: 0 },
    end: T + 3 * 3_600_000,
    sessions: 2,
  });
  expect(html).toContain('$4.00</b> in this bucket');
  expect(html).toContain('$27.40 that day, as its cost bar shows');
  expect(html).toContain('2 Sessions working then');
  expect(render(day)).not.toContain('in this bucket');
});

test('reports reading instead of claiming there is no bucket', () => {
  const html = render(null, true);
  expect(html).toContain('Reading bucket');
  expect(html).not.toContain('No bucket');
});

test('lists the eight busiest processes and folds the rest into a disclosure', () => {
  const [one] = day.processes;
  if (one === undefined) {
    throw new Error('no process');
  }
  const many = Array.from({ length: 173 }, (_, index) => ({
    ...one,
    pid: 1000 + index,
    processId: index,
  }));
  const html = render({ ...day, processes: many });
  const [shown = ''] = html.split('<details');
  expect(shown.match(/pid \d+/g)).toHaveLength(8);
  expect(html).toContain('165 more processes');
  expect(html).toContain('pid 1172');
  expect(render({ ...day, processes: many.slice(0, 8) })).not.toContain('more process');
});
