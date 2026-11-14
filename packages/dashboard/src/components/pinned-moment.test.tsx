import { expect, test } from 'bun:test';

import { PinnedMomentBody } from './pinned-moment.tsx';
import type { MomentRead } from './pinned-moment.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 14, 12);

// A moment read in, with server-1's sample a minute before the pin.
const ready = (at: number): MomentRead => ({
  moment: {
    at,
    sessions: [],
    system: 'server-1',
    vitals: { cpu: 40, load: 1.2, memory: 55, t: at - MIN },
  },
  state: 'ready',
});

// The links to server-1's page at the sample, read from the card pinned at `at`.
const sampleLinks = async (at: number) => {
  const html = await renderRouted(
    <PinnedMomentBody
      events={[]}
      now={NOW}
      onClear={() => {}}
      pin={{ at, system: 'server-1' }}
      read={ready(at)}
      timeZone="UTC"
    />,
    { path: '/activity', routePaths: ['/activity', '/systems/$name'] },
  );
  return linksIn(html)
    .filter(({ label }) => label.startsWith('Open server-1'))
    .map(({ href }) => new URL(href ?? '', 'http://dashboard'));
};

test('the card links to the System page at the sample, on the shortest range whose charts hold it', async () => {
  const old = NOW - 3 * 24 * HOUR;
  const links = await sampleLinks(old);
  // One link in the columns, one in the phone summary.
  expect(links).toHaveLength(2);
  for (const url of links) {
    expect(url.pathname).toBe('/systems/server-1');
    expect(url.searchParams.get('at')).toBe(String(old - MIN));
    expect(url.searchParams.get('range')).toBe('7d');
    expect(url.searchParams.get('tab')).toBe('vitals');
  }
  const recent = await sampleLinks(NOW - 10 * HOUR);
  expect(recent.map((url) => url.searchParams.get('range'))).toEqual(['12h', '12h']);
});
