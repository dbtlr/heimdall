import { expect, test } from 'bun:test';

import { groupActivity } from '../lib/activity.ts';
import type { ActivityEvent } from '../server/activity-types.ts';
import { ActivityListBody } from './activity-list.tsx';
import { renderRouted } from './render-routed.tsx';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 14, 12);
const events: ActivityEvent[] = [
  {
    action: 'raised',
    at: NOW - 3 * HOUR,
    condition: 'service_down',
    conditionId: '7',
    kind: 'condition',
    level: 'alert',
    open: true,
    previousLevel: undefined,
    raisedAt: NOW - 3 * HOUR,
    reason: 'Exited with status 1.',
    subject: 'caddy',
    system: 'server-1',
  },
  {
    at: NOW - 3 * HOUR + MIN,
    condition: 'service_down',
    kind: 'alert',
    open: false,
    recoveredAt: NOW - 2 * HOUR,
    subject: 'caddy',
    system: 'server-1',
  },
  {
    at: NOW - 30 * HOUR,
    from: '2.11.0',
    kind: 'version',
    service: 'ntfy',
    system: 'laptop-1',
    to: '2.12.0',
  },
];

test('the list heads each day, shows an alert sent on its Condition, and labels unpaired Systems', async () => {
  const html = await renderRouted(
    <ActivityListBody
      lines={groupActivity(events)}
      now={NOW}
      timeZone="UTC"
      unpaired={new Set(['laptop-1'])}
    />,
    {
      routePaths: [
        '/systems/$name',
        '/systems/$name/conditions/$id',
        '/systems/$name/services/$service',
      ],
    },
  );
  expect(html).toContain('>Today<');
  expect(html).toContain('>Yesterday<');
  expect(html).toContain('alert sent');
  // The lead's own alert says its recovery once, after "Alert pushed at".
  expect(html).toContain('Alert pushed at 09:01, recovery at 10:00');
  expect(html.match(/recovery at 10:00/gu)).toHaveLength(1);
  expect(html).toContain('href="/systems/server-1/conditions/7"');
  expect(html).toContain('ntfy 2.11.0 → 2.12.0');
  expect(html.match(/unpaired/gu)).toHaveLength(1);
});

test('a cleared Drift takes the cleared ring, not its level glyph', async () => {
  const cleared: ActivityEvent = {
    action: 'cleared',
    at: NOW - HOUR,
    condition: 'drift',
    conditionId: '9',
    kind: 'drift',
    level: 'warning',
    open: false,
    previousLevel: undefined,
    raisedAt: NOW - 2 * HOUR,
    reason: 'The file matches its record again.',
    subject: '/etc/caddy/Caddyfile',
    system: 'server-1',
  };
  const html = await renderRouted(
    <ActivityListBody
      lines={groupActivity([cleared])}
      now={NOW}
      timeZone="UTC"
      unpaired={new Set()}
    />,
    { routePaths: ['/systems/$name', '/systems/$name/conditions/$id'] },
  );
  expect(html).toContain('stroke-status-good');
  expect(html).not.toContain('fill-status-serious');
});

test('an alert merged into a stop line says when its recovery went out, with its alert and in the list zone', async () => {
  const html = await renderRouted(
    <ActivityListBody
      lines={groupActivity([
        {
          at: NOW,
          kind: 'stop',
          lasted: 4000,
          ongoing: false,
          restarts: 0,
          service: 'caddy',
          system: 'server-1',
        },
        {
          at: NOW + MIN,
          condition: 'service_down',
          kind: 'alert',
          open: false,
          recoveredAt: NOW + 5 * MIN,
          subject: 'backup',
          system: 'server-1',
        },
      ])}
      now={NOW}
      timeZone="Asia/Kolkata"
      unpaired={new Set()}
    />,
    {
      routePaths: [
        '/systems/$name',
        '/systems/$name/conditions/$id',
        '/systems/$name/services/$service',
      ],
    },
  );
  // 12:05 UTC is 17:35 in Kolkata.
  expect(html).toContain('Alert sent for Service down backup, recovery at 17:35');
});

const alertRecovering = (at: number, recoveredAt: number): ActivityEvent => ({
  at,
  condition: 'service_down',
  kind: 'alert',
  open: false,
  recoveredAt,
  subject: 'caddy',
  system: 'server-1',
});

const renderAlert = (event: ActivityEvent) =>
  renderRouted(
    <ActivityListBody
      lines={groupActivity([event])}
      now={NOW}
      timeZone="UTC"
      unpaired={new Set()}
    />,
    { routePaths: ['/systems/$name', '/systems/$name/conditions/$id'] },
  );

test('a recovery on a later local day than its alert names the day', async () => {
  const pushed = Date.UTC(2026, 10, 12, 23, 50);
  const html = await renderAlert(alertRecovering(pushed, pushed + 20 * MIN));
  expect(html).toContain('Alert pushed at 23:50, recovery at Fri 00:10');
});

test('a recovery on the same local day as its alert shows only the time', async () => {
  const pushed = Date.UTC(2026, 10, 12, 22, 30);
  const html = await renderAlert(alertRecovering(pushed, pushed + 20 * MIN));
  expect(html).toContain('Alert pushed at 22:30, recovery at 22:50');
});

test.each([
  [6, 'Wed 23:50'],
  [7, 'Thu 19 Nov 23:50'],
  [10, 'Sun 22 Nov 23:50'],
])('a recovery %d days after its alert names its day as %s', async (days, text) => {
  const pushed = Date.UTC(2026, 10, 12, 23, 50);
  const html = await renderAlert(alertRecovering(pushed, pushed + days * 24 * 60 * MIN));
  expect(html).toContain(`recovery at ${text}`);
});
