import { expect, test } from 'bun:test';

import type { SessionRow } from '../server/system-detail-types.ts';
import { DetailAxis } from './detail-track.tsx';
import { renderRouted } from './render-routed.tsx';
import { SessionLanes } from './session-lanes.tsx';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const WINDOW = { from: NOW - 12 * HOUR, to: NOW };

// A Session that started `startedAgo` hours ago and last worked `endedAgo` hours ago.
const session = (name: string, startedAgo: number, endedAgo: number): SessionRow => ({
  branch: undefined,
  costUsd: 1,
  harness: 'claude-code',
  project: `project-${name}`,
  sessionId: name,
  source: 'local',
  stretches: [
    { endedAt: NOW - endedAgo * HOUR, link: 'linked', startedAt: NOW - startedAgo * HOUR },
  ],
});

// The Sessions in `html`, in the order their lanes draw them.
const order = (html: string) => [...html.matchAll(/project-(\w)/gu)].map(([, name]) => name);

test('shows the most recently active Sessions, an ongoing one included, in start order, and folds the oldest', async () => {
  // In order of first stretch, as the Hub lists them; the last one is still going.
  const sessions = [
    session('a', 11, 10),
    session('b', 10, 3),
    session('c', 9, 4),
    session('d', 8, 5),
    session('e', 7, 6),
    session('f', 6, 2),
    session('g', 1, 0),
  ];
  const html = await renderRouted(
    <DetailAxis onSelect={() => {}} selected={undefined} window={WINDOW}>
      <SessionLanes sessions={sessions} system="server-1" window={WINDOW} />
    </DetailAxis>,
  );
  const [shown = '', folded = ''] = html.split('<details');

  expect(order(shown)).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
  expect(order(folded)).toEqual(['a']);
});
