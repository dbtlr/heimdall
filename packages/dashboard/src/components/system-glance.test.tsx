import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SystemGlance } from './system-glance.tsx';

test('a quiet System dates its last reported Vitals instead of calling them current', () => {
  const html = renderToStaticMarkup(
    <SystemGlance
      detail={{
        latest: {
          cpuBusyPercent: 23,
          disks: [],
          load: [1, 2, 3],
          memoryTotalBytes: 16 * 1024 ** 3,
          memoryUsedBytes: 8 * 1024 ** 3,
          t: 0,
          uptimeSeconds: 86400,
        },
        now: 600_000,
      }}
    />,
  );
  expect(html).toContain('Last reported');
  expect(html).not.toContain('Right now');
  expect(html).toContain('23%');
  expect(html).toContain('No disk sample');
});

test('a System without samples does not invent zero readings', () => {
  const html = renderToStaticMarkup(<SystemGlance detail={{ latest: undefined, now: 0 }} />);
  expect(html).toContain('No Vitals sample');
  expect(html).not.toContain('0%');
});
