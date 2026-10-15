import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { TimelineRail } from './timeline-rail.tsx';

test('shows each transition in recording order and labels a backfilled level', () => {
  const html = renderToStaticMarkup(
    <TimelineRail
      entries={[
        {
          clearedAt: 400,
          id: '1',
          kind: 'low_disk',
          level: 'warning',
          raisedAt: 100,
          reason: '80% used',
          subject: '/',
          transitions: [
            { at: 100, backfilled: true, kind: 'raised', level: 'note', reason: '70% used' },
            {
              at: 300,
              backfilled: false,
              kind: 'level_changed',
              level: 'warning',
              previousLevel: 'note',
              reason: '80% used',
            },
            { at: 400, backfilled: false, kind: 'cleared', level: 'warning', reason: '80% used' },
          ],
        },
      ]}
      now={500}
    />,
  );
  expect(html).toContain('Backfilled level');
  expect(html).toContain('note → warning');
  expect(html).toContain('Cleared at warning');
  expect(html).toContain('70% used');
  expect(html.indexOf('Raised at note')).toBeLessThan(html.indexOf('note → warning'));
  expect(html.indexOf('note → warning')).toBeLessThan(html.indexOf('Cleared at warning'));
});
