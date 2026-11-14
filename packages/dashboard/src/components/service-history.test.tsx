import { expect, test } from 'bun:test';

import { historyRows } from '../lib/service-detail.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { renderRouted } from './render-routed.tsx';
import { historyKey, ServiceHistory } from './service-history.tsx';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const HOUR = 3_600_000;

const detail = (over: Partial<ServiceDetail> = {}): ServiceDetail => ({
  downs: [],
  installed: { missingApplication: undefined, upstream: null, version: null },
  installs: [],
  note: undefined,
  now: NOW,
  recorded: undefined,
  reported: [],
  selection: undefined,
  service: 'web',
  stops: [],
  system: 'server-1',
  unit: undefined,
  update: { failure: undefined, status: undefined },
  updates: [],
  ...over,
});

const raised = (hoursAgo: number, condition: string) => ({
  at: NOW - hoursAgo * HOUR,
  condition,
  kind: 'raised' as const,
  reason: 'Stopped: ActiveState=failed',
});

test('a Service down links its Condition and the rest wait behind Show older', async () => {
  const html = await renderRouted(
    <ServiceHistory
      detail={detail({
        downs: [1, 2, 3, 4, 5, 6, 7, 8].map((hours) => raised(hours, `c${String(hours)}`)),
      })}
    />,
  );

  expect(html).toContain('href="/systems/server-1/conditions/c1"');
  expect(html).toContain('Stopped: ActiveState=failed');
  expect(html).toContain('Show 2 older');
  const times = [...html.matchAll(/<time [^>]*datetime="([^"]+)"/gi)].map(([, at]) => at);
  expect(times).toEqual(
    [1, 2, 3, 4, 5, 6].map((hours) => new Date(NOW - hours * HOUR).toISOString()),
  );
});

test('a cleared Service down reads as cleared', async () => {
  const html = await renderRouted(
    <ServiceHistory
      detail={detail({
        downs: [
          {
            at: NOW - HOUR,
            condition: '9',
            kind: 'cleared',
            reason: 'Stopped: ActiveState=failed',
          },
        ],
      })}
    />,
  );

  expect(html).toContain('Service down cleared');
  expect(html).not.toContain('Show');
});

test('nothing renders with no Service down', async () => {
  expect(await renderRouted(<ServiceHistory detail={detail()} />)).toBe('');
});

test('a new installed version says what it replaced', async () => {
  const html = await renderRouted(
    <ServiceHistory
      detail={detail({ installs: [{ at: NOW - 2 * HOUR, version: '1.28', was: '1.27' }] })}
    />,
  );
  expect(html).toContain('Installed 1.28');
  expect(html).toContain('Was 1.27');
});

test('an available update is a neutral dated row beside an install at the same time', async () => {
  const html = await renderRouted(
    <ServiceHistory
      detail={detail({
        installs: [{ at: NOW - HOUR, version: '2.0', was: '1.0' }],
        updates: [
          { at: NOW - HOUR, version: '3.0' },
          { at: NOW - HOUR, version: '3.0-alpine' },
        ],
      })}
    />,
  );
  expect(html).toContain('Update available 3.0');
  expect(html).toContain('Update available 3.0-alpine');
  expect(html).toContain('Installed 2.0');
  expect(html).toContain('bg-muted-foreground');
  expect(html).toContain(`dateTime="${new Date(NOW - HOUR).toISOString()}"`);
  expect(html).not.toContain('bg-status-good');
});

test('history keys distinguish releases and an installed version at the same instant', () => {
  const rows = historyRows(
    [],
    [{ at: NOW, version: '2.0', was: '1.0' }],
    [
      { at: NOW, version: '3.0' },
      { at: NOW, version: '3.0-alpine' },
    ],
    NOW,
  );
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map(historyKey)).size).toBe(3);
});
