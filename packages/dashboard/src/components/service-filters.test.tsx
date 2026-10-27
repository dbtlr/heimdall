import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ServiceSummary } from '../lib/services.ts';
import { ActiveServiceFilters, ServiceFilterSheet } from './service-filters.tsx';

const rows: ServiceSummary[] = [
  {
    downSince: 0,
    latestStopAt: undefined,
    name: 'web',
    status: 'down',
    system: 'alpha',
    update: undefined,
    version: null,
  },
  {
    downSince: undefined,
    latestStopAt: undefined,
    name: 'api',
    status: 'up',
    system: 'beta',
    update: undefined,
    version: null,
  },
];
const ignore = () => {};

test('active filters have individually labelled removal controls and Clear', () => {
  const html = renderToStaticMarkup(
    <ActiveServiceFilters
      filters={{ status: ['down', 'up'], system: ['alpha'] }}
      onChange={ignore}
    />,
  );
  expect(html).toContain('aria-label="Remove Down filter"');
  expect(html).toContain('aria-label="Remove Up filter"');
  expect(html).toContain('aria-label="Remove alpha filter"');
  expect(html).toContain('Clear</button>');
  expect(
    renderToStaticMarkup(
      <ActiveServiceFilters filters={{ status: [], system: [] }} onChange={ignore} />,
    ),
  ).toBe('');
});

test('sheet labels its sections, reflects selection and counts, and keeps zero-count chips selectable', () => {
  const html = renderToStaticMarkup(
    <ServiceFilterSheet
      filters={{ status: ['up'], system: ['alpha'] }}
      onApply={ignore}
      onChange={ignore}
      onClose={ignore}
      open
      rows={rows}
    />,
  );
  expect(html).toContain('aria-labelledby="service-filter-title"');
  expect(html).toContain('<legend');
  expect(html).toContain('Status</legend>');
  expect(html).toContain('System</legend>');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-label="Up, 0 Services"');
  expect(html).toContain('aria-label="alpha, 0 Services"');
  expect(html).not.toContain('disabled');
  expect(html).toContain('Clear all</button>');
  expect(html).toContain('Show 0 Services');
  expect(html).toContain('Close</button>');
});

test('a single Service reads in the singular', () => {
  const html = renderToStaticMarkup(
    <ServiceFilterSheet
      filters={{ status: [], system: [] }}
      onApply={ignore}
      onChange={ignore}
      onClose={ignore}
      open
      rows={rows.slice(0, 1)}
    />,
  );
  expect(html).toContain('Show 1 Service<');
  expect(html).toMatch(/aria-label="[^"]*, 1 Service"/u);
});

test('active filters form an accessible group', () => {
  const html = renderToStaticMarkup(
    <ActiveServiceFilters filters={{ status: ['down'], system: [] }} onChange={ignore} />,
  );
  expect(html).toMatch(/<div(?=[^>]*role="group")(?=[^>]*aria-label="Active filters")/u);
});

test('Updates has its own count, follows Restarted, and labels its active pill', () => {
  const services = structuredClone(rows);
  for (const row of services) {
    row.update = '2.0';
  }
  const html = renderToStaticMarkup(
    <ServiceFilterSheet
      filters={{ status: ['updates'], system: [] }}
      onApply={ignore}
      onChange={ignore}
      onClose={ignore}
      open
      rows={services}
    />,
  );
  expect(html).toContain('aria-label="Updates, 2 Services" aria-pressed="true"');
  expect(html.indexOf('aria-label="Restarted')).toBeLessThan(html.indexOf('aria-label="Updates'));
  expect(html.indexOf('aria-label="Updates')).toBeLessThan(html.indexOf('aria-label="Up,'));
  expect(
    renderToStaticMarkup(
      <ActiveServiceFilters filters={{ status: ['updates'], system: [] }} onChange={ignore} />,
    ),
  ).toContain('Remove Updates filter');
});
