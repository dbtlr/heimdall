import { expect, test } from 'bun:test';

import { renderRouted } from './render-routed.tsx';
import { TimelineTable, TimelineTableBody } from './timeline-table.tsx';

const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour, minute);
const NOW = at(27, 12);

const entries = [
  {
    clearedAt: undefined,
    id: 'open',
    kind: 'low_disk' as const,
    level: 'alert' as const,
    paired: true,
    raisedAt: at(27, 9),
    reason: '95% used',
    subject: '/',
    system: 'gateway-1',
    transitions: [
      {
        at: at(27, 9),
        backfilled: true,
        kind: 'raised' as const,
        level: 'note' as const,
        reason: '70% used',
      },
      {
        at: at(27, 10),
        backfilled: false,
        kind: 'level_changed' as const,
        level: 'warning' as const,
        previousLevel: 'note' as const,
        reason: '80% used',
      },
      {
        at: at(27, 11),
        backfilled: false,
        kind: 'level_changed' as const,
        level: 'alert' as const,
        previousLevel: 'warning' as const,
        reason: '95% used',
      },
    ],
  },
  {
    clearedAt: at(26, 23, 30),
    id: 'done',
    kind: 'low_disk' as const,
    level: 'note' as const,
    paired: false,
    raisedAt: at(26, 23),
    reason: '71% used',
    subject: '/data',
    system: 'old box',
    transitions: [
      {
        at: at(26, 23),
        backfilled: false,
        kind: 'raised' as const,
        level: 'note' as const,
        reason: '71% used',
      },
      {
        at: at(26, 23, 30),
        backfilled: false,
        kind: 'cleared' as const,
        level: 'note' as const,
        reason: 'back to 60%',
      },
    ],
  },
];

const render = (list = entries) =>
  renderRouted(<TimelineTableBody entries={list} now={NOW} timeZone="UTC" />);

test('rows keep the given order under their day headings', async () => {
  const html = await render();
  expect(html.indexOf('Today')).toBeLessThan(html.indexOf('/systems/gateway-1'));
  expect(html.indexOf('/systems/gateway-1')).toBeLessThan(html.indexOf('Yesterday'));
  expect(html.indexOf('Yesterday')).toBeLessThan(html.indexOf('/systems/old%20box'));
  expect(html.match(/<tr class="border-t"/g)).toHaveLength(2);
  expect(html).toContain('09:00');
});

test('a System link opens its Timeline tab and an unpaired System is tagged', async () => {
  const html = await render();
  expect(html).toContain('href="/systems/gateway-1?tab=timeline"');
  expect(html).toContain('href="/systems/gateway-1/conditions/open"');
  expect(html.match(/Unpaired/g)).toHaveLength(1);
});

test('an open occurrence shows how long it has been open, a cleared one how long it lasted', async () => {
  const html = await render();
  expect(html).toContain('Open for 3 h');
  expect(html).toContain('Cleared after 30 min');
});

test('transitions list in recording order with a backfilled label and the last reason', async () => {
  const html = await render();
  expect(html).toContain('Raised at note');
  expect(html).toContain('(Backfilled level)');
  expect(html.indexOf('Raised at note')).toBeLessThan(html.indexOf('warning'));
  expect(html.indexOf('warning')).toBeLessThan(html.lastIndexOf('alert'));
  expect(html).toContain('Cleared at note');
  expect(html).toContain('back to 60%');
  expect(html).not.toContain('70% used');
});

test('before the zone is known the table renders nothing', async () => {
  expect(await renderRouted(<TimelineTable entries={entries} now={NOW} />)).toBe('');
});
