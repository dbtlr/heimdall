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
    clearedAt: undefined,
    condition: 'service_down',
    conditionId: '7',
    kind: 'condition',
    level: 'alert',
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
  expect(html).toContain('recovery at 10:00');
  expect(html).toContain('href="/systems/server-1/conditions/7"');
  expect(html).toContain('ntfy 2.11.0 → 2.12.0');
  expect(html.match(/unpaired/gu)).toHaveLength(1);
});
