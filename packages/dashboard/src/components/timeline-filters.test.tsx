import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { emptyTimelineFilters } from '../lib/timeline-filters.ts';
import { ActiveTimelineFilters, TimelineFilterSheet } from './timeline-filters.tsx';

const entries = [
  { clearedAt: undefined, level: 'alert' as const, paired: true, system: 'alpha' },
  { clearedAt: 5, level: 'note' as const, paired: false, system: 'gone' },
];
const ignore = () => {};
const sheet = (filters = emptyTimelineFilters()) =>
  renderToStaticMarkup(
    <TimelineFilterSheet
      entries={entries}
      filters={filters}
      onApply={ignore}
      onChange={ignore}
      onClose={ignore}
      open
    />,
  );

test('active filters have individually labelled removal controls and Clear', () => {
  const html = renderToStaticMarkup(
    <ActiveTimelineFilters
      entries={entries}
      filters={{ level: ['alert'], status: ['open'], system: ['gone'] }}
      onChange={ignore}
    />,
  );
  expect(html).toContain('aria-label="Remove Alert filter"');
  expect(html).toContain('aria-label="Remove Open filter"');
  expect(html).toContain('aria-label="Remove gone · Unpaired · history kept filter"');
  expect(html).toContain('Clear</button>');
  expect(html).toMatch(/<div(?=[^>]*role="group")(?=[^>]*aria-label="Active filters")/u);
  expect(
    renderToStaticMarkup(
      <ActiveTimelineFilters
        entries={entries}
        filters={emptyTimelineFilters()}
        onChange={ignore}
      />,
    ),
  ).toBe('');
});

test('sheet has Level, System, and Status sections with counts', () => {
  const html = sheet();
  expect(html).toContain('aria-labelledby="timeline-filter-title"');
  expect(html.indexOf('Level</legend>')).toBeGreaterThan(-1);
  expect(html.indexOf('Level</legend>')).toBeLessThan(html.indexOf('System</legend>'));
  expect(html.indexOf('System</legend>')).toBeLessThan(html.indexOf('Status</legend>'));
  expect(html).toContain('aria-label="Alert, 1 occurrences"');
  expect(html).toContain('aria-label="Warning, 0 occurrences"');
  expect(html).toContain('aria-label="alpha, 1 occurrences"');
  expect(html).toContain('aria-label="gone · Unpaired · history kept, 1 occurrences"');
  expect(html).toContain('aria-label="Open, 1 occurrences"');
  expect(html).toContain('aria-label="Cleared, 1 occurrences"');
  expect(html).toContain('Show 2 occurrences');
});

test('selection constrains the other sections and zero-count chips stay selectable', () => {
  const html = sheet({ level: ['alert'], status: [], system: [] });
  expect(html).toContain('aria-label="Alert, 1 occurrences" aria-pressed="true"');
  expect(html).toContain('aria-label="gone · Unpaired · history kept, 0 occurrences"');
  expect(html).toContain('aria-label="Cleared, 0 occurrences"');
  expect(html).not.toContain('disabled');
  expect(html).toContain('Show 1 occurrences');
  expect(html).toContain('Clear all</button>');
});
