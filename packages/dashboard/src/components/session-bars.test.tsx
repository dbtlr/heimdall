import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionRow } from '../server/system-detail-types.ts';
import { SessionBars } from './session-rows.tsx';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const WINDOW = { from: NOW - 6 * HOUR, to: NOW };

const session = (sessionId: string, link: 'ambiguous' | 'linked'): SessionRow => ({
  branch: undefined,
  costUsd: 1.5,
  harness: 'claude-code',
  project: `project-${sessionId}`,
  sessionId,
  source: 'local',
  stretches: [
    { endedAt: NOW - 4 * HOUR, link, startedAt: NOW - 5 * HOUR },
    { endedAt: NOW - HOUR, link, startedAt: NOW - 2 * HOUR },
  ],
});

// The desktop overview's lanes and the phone's Sessions tab draw their bars
// through this one component, each with its own label.
test('draws a row per Session with a bar per stretch in its link style, and the label beside it', () => {
  const html = renderToStaticMarkup(
    <SessionBars
      label={(row) => `label-${row.sessionId}`}
      labelClassName="label-class"
      sessions={[session('a', 'linked'), session('b', 'ambiguous')]}
      window={WINDOW}
    />,
  );

  expect(html.match(/rounded-\[2px\] bg-current/gu)).toHaveLength(2);
  expect(html.match(/border-dashed/gu)).toHaveLength(2);
  expect(html).toContain('label-a');
  expect(html).toContain('label-b');
  expect(html).toContain('label-class');
  // Two rows of 22 pixels.
  expect(html).toContain('height:44px');
});
