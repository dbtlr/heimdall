import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { groupActivity } from '../lib/activity.ts';
import type { ActivityEvent } from '../server/activity-types.ts';
import type { ConditionMark } from '../server/fleet-overview-types.ts';
import { ActivityListBody } from './activity-list.tsx';
import { ConditionSpans } from './condition-spans.tsx';
import { renderRouted } from './render-routed.tsx';

const occurrence: ConditionMark = {
  clearedAt: undefined,
  id: '1',
  kind: 'low_disk',
  level: 'alert',
  raisedAt: 0,
  subject: '/',
  transitions: [
    { at: 0, backfilled: false, kind: 'raised', level: 'note', reason: '70% used' },
    {
      at: 50,
      backfilled: false,
      kind: 'level_changed',
      level: 'alert',
      previousLevel: 'note',
      reason: '90% used',
    },
  ],
};

test('a Condition bar keeps the level that applied to each part of its span', () => {
  const html = renderToStaticMarkup(
    <ConditionSpans conditions={[occurrence]} now={100} window={{ from: 0, to: 100 }} />,
  );
  expect(html).toContain('bg-status-warning');
  expect(html).toContain('bg-status-critical');
  expect(html.match(/width:50%/gu)).toHaveLength(2);
});

test('an open occurrence ahead of a rolled-back clock has no future bar or label', () => {
  const future: ConditionMark = {
    ...occurrence,
    raisedAt: 200,
    transitions: [
      { at: 200, backfilled: false, kind: 'raised', level: 'alert', reason: '90% used' },
    ],
  };
  const html = renderToStaticMarkup(
    <ConditionSpans conditions={[future]} now={100} window={{ from: 0, to: 100 }} />,
  );
  expect(html).toContain('None in this range.');
  expect(html).not.toContain('Low disk');
});

test('hot process spans and Activity name the executable and PID without exposing its identity tuple', async () => {
  const process: ConditionMark = {
    ...occurrence,
    kind: 'hot_process',
    subject: JSON.stringify(['boot-1', 42, '123', 'compiler']),
  };
  const raised: ActivityEvent = {
    action: 'raised',
    at: 0,
    condition: 'hot_process',
    conditionId: process.id,
    kind: 'condition',
    level: 'warning',
    open: true,
    previousLevel: undefined,
    raisedAt: 0,
    reason: 'CPU load',
    subject: process.subject,
    system: 'gateway-1',
  };
  const views = [
    <ConditionSpans conditions={[process]} now={100} window={{ from: 0, to: 100 }} />,
    <ActivityListBody
      lines={groupActivity([raised])}
      now={100}
      timeZone="UTC"
      unpaired={new Set()}
    />,
  ];
  for (const html of await Promise.all(views.map((view) => renderRouted(view)))) {
    expect(html).toContain('compiler (PID 42)');
    expect(html).toContain('Hot process');
    expect(html).not.toContain('boot-1');
  }
});
