import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ConditionMark } from '../server/fleet-overview-types.ts';
import { ChangesLane } from './changes-lane.tsx';
import { DetailAxis } from './detail-track.tsx';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 12, 6, 4);
const WINDOW = { from: NOW - 7 * DAY, to: NOW };

const mark = (overrides: Partial<ConditionMark> & Pick<ConditionMark, 'kind'>): ConditionMark => ({
  clearedAt: undefined,
  id: `${overrides.kind}-${String(overrides.raisedAt)}`,
  level: 'warning',
  raisedAt: NOW - HOUR,
  subject: '',
  transitions: [],
  ...overrides,
});

const restart = {
  at: NOW - 10 * MINUTE,
  kind: 'stop',
  lasted: 4000,
  ongoing: false,
  restarts: 0,
  service: 'db',
  system: 'server-1',
} as const;

const lane = (conditions: ConditionMark[]) =>
  renderToStaticMarkup(
    <DetailAxis onSelect={() => {}} selected={undefined} window={WINDOW}>
      <ChangesLane
        detail={{
          changes: [restart],
          conditions,
          now: NOW,
          paired: true,
        }}
        window={WINDOW}
      />
    </DetailAxis>,
  );

test('lists the latest events under the lane and keeps the earlier ones behind a disclosure', () => {
  const html = lane([
    ...Array.from({ length: 6 }, (_, i) =>
      mark({
        clearedAt: NOW - (6 - i) * DAY + HOUR,
        kind: 'drift',
        raisedAt: NOW - (6 - i) * DAY,
        subject: `/etc/f${String(i)}`,
      }),
    ),
    mark({ kind: 'service_down', level: 'alert', raisedAt: NOW - 30 * MINUTE, subject: 'web' }),
    mark({ kind: 'job_failing', level: 'alert', raisedAt: NOW - 20 * MINUTE, subject: 'backup' }),
  ]);
  const [shown = '', earlier = ''] = html.split('<details');

  for (const text of ['Service down web, alert', 'Job failing backup, alert', 'db restarted']) {
    expect(shown).toContain(text);
  }
  expect(earlier).toContain('Show 3 earlier events');
  for (const text of ['/etc/f0', '/etc/f1', '/etc/f2']) {
    expect(earlier).toContain(text);
    expect(shown).not.toContain(text);
  }
});

test('shows a recent restart ahead of Conditions open longer, however many are open', () => {
  const html = lane(
    Array.from({ length: 7 }, (_, i) =>
      mark({ kind: 'low_disk', raisedAt: NOW - (i + 1) * HOUR, subject: `/disk${String(i)}` }),
    ),
  );
  const [shown = '', earlier = ''] = html.split('<details');

  expect(shown).toContain('db restarted');
  expect(earlier).toContain('Show 2 earlier events');
  for (const text of ['/disk5', '/disk6']) {
    expect(earlier).toContain(text);
    expect(shown).not.toContain(text);
  }
});
