import { expect, test } from 'bun:test';

import type { SystemDetail } from '../server/system-detail-types.ts';
import { renderRouted } from './render-routed.tsx';
import { SystemCharts } from './system-charts.tsx';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

const detail = (range: '30d' | '1y'): SystemDetail => ({
  bucketMs: range === '30d' ? 3 * HOUR : DAY,
  changes: [],
  collectorVersion: '1.0.0',
  conditions: [],
  cpu: [],
  cpuCores: undefined,
  diskTrends: [],
  edges: [NOW - 31 * DAY, NOW + HOUR],
  from: NOW - (range === '30d' ? 30 : 365) * DAY,
  gaps: [],
  harnesses: [],
  lastSeenAt: NOW,
  latest: undefined,
  limitPercent: undefined,
  load: [],
  long: { changeEdges: [], costs: [], dayEdges: [], reboots: [], sessions: 0 },
  memory: [],
  name: 'server-1',
  now: NOW,
  paired: true,
  platform: undefined,
  processes: [],
  range,
  sessions: [],
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  to: NOW,
});

const render = (range: '30d' | '1y') =>
  renderRouted(
    <SystemCharts
      bucket={null}
      detail={detail(range)}
      onSelect={() => {}}
      sample={null}
      view="vitals"
    />,
  );

test("the phone's CPU note names the bucket width, as the long ranges draw it", async () => {
  expect(await render('30d')).toContain('avg, low–high · 3 h');
  expect(await render('1y')).toContain('avg, low–high · 1 d');
});
