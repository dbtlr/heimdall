import { expect, test } from 'bun:test';

import { activityCounts } from '../lib/activity.ts';
import type { ActivityEvent } from '../server/activity-types.ts';
import { KindChips } from './activity-filters.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 14, 12);

// A Condition raised and the alert sent on it a minute later, which share a
// line, and a version change on another System.
const events: ActivityEvent[] = [
  {
    action: 'raised',
    at: NOW - 60 * MIN,
    condition: 'service_down',
    conditionId: '7',
    kind: 'condition',
    level: 'alert',
    open: true,
    previousLevel: undefined,
    raisedAt: NOW - 60 * MIN,
    reason: 'Exited with status 1.',
    subject: 'caddy',
    system: 'server-1',
  },
  {
    at: NOW - 59 * MIN,
    condition: 'service_down',
    kind: 'alert',
    open: true,
    recoveredAt: undefined,
    subject: 'caddy',
    system: 'server-1',
  },
  {
    at: NOW - 30 * MIN,
    from: '2.11.0',
    kind: 'version',
    service: 'ntfy',
    system: 'laptop-1',
    to: '2.12.0',
  },
];

test('All counts the lines every kind shows, not the sum of the kind chips', async () => {
  const labels = linksIn(
    await renderRouted(<KindChips counts={activityCounts(events, {})} current={undefined} />),
  ).map(({ label }) => label);
  expect(labels).toContain('All 2');
  expect(labels).toContain('Conditions 1');
  expect(labels).toContain('Alerts sent 1');
  expect(labels).toContain('Versions 1');
});
