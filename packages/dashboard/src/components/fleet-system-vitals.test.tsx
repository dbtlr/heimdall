import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { FleetSystemVitals } from './fleet-system-vitals.tsx';

test('Fleet dates stale Vitals and names the fullest disk instead of claiming old readings are current', () => {
  const html = renderToStaticMarkup(
    <FleetSystemVitals
      now={600_000}
      latest={{
        cpuBusyPercent: 24,
        disks: [
          { mount: '/', totalBytes: 100, usedBytes: 40 },
          { mount: '/data', totalBytes: 200, usedBytes: 180 },
        ],
        memoryUsedPercent: 63,
        t: 0,
      }}
    />,
  );
  expect(html).toContain('Last reported');
  expect(html).toContain('24%');
  expect(html).toContain('63%');
  expect(html).toContain('90%');
  expect(html).toContain('disk /data');
  expect(html).not.toContain('Right now');
});

test('missing samples remain unknown', () => {
  const html = renderToStaticMarkup(<FleetSystemVitals latest={undefined} now={600_000} />);
  expect(html).toContain('No Vitals sample');
  expect(html).not.toContain('0%');
});

test('readings always carry their sample time rather than a freshness claim across System clocks', () => {
  for (const t of [60_000, -180_000]) {
    const html = renderToStaticMarkup(
      <FleetSystemVitals
        latest={{ cpuBusyPercent: 24, disks: [], memoryUsedPercent: 63, t }}
        now={0}
      />,
    );
    expect(html).toContain('Last reported');
    expect(html).toContain(new Date(t).toISOString());
    expect(html).not.toContain('Right now');
  }
});

test('a sample with an unknown memory capacity never displays zero memory use', () => {
  const html = renderToStaticMarkup(
    <FleetSystemVitals
      latest={{ cpuBusyPercent: 24, disks: [], memoryUsedPercent: undefined, t: 0 }}
      now={0}
    />,
  );
  expect(html).toContain('memory unavailable');
  expect(html).not.toContain('0%');
});
